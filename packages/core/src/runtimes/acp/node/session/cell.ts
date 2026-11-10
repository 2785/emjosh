import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk';
import type { Result } from '@emdash/shared';
import { ok, toSerializedError } from '@emdash/shared';
import type {
  AcpCancelTurnError,
  AcpPermissionRequest,
  AcpRuntimeError,
  AcpSendPromptError,
  AcpSetOptionError,
  InvalidStateError,
  NormalizedEvent,
  PromptInput,
  QueuedPrompt,
  SessionConfigState,
  SessionState,
  SessionUsage,
  StopReason,
  ToolCallItem,
  ToolNode,
  TranscriptTurn,
  TranscriptTurnOutcome,
} from '#runtimes/acp/api';
import {
  AcpTranscriptParser,
  acpErr,
  createToolCallItem,
  makeToolId,
  SESSION_PLAN_ID,
} from '#runtimes/acp/api';
import { acceptsProviderValue } from '#runtimes/acp/api/models/config';
import { wrapHiddenContext } from '#runtimes/acp/api/models/prompt';
import {
  type Command,
  type DomainEvent,
  type Effect,
  mergeQueuedPrompts,
  SessionMachine,
  type SessionMachineContext,
} from '#runtimes/acp/node/machine/machine';
import { createMachineEffectDriver, type MachineEffectDriver } from '../machine/primitive';
import type { PromptAcceptance, SessionCellDeps, SessionPromptResult } from './cell-deps';
import { PermissionBroker } from './permission-broker';
import { RawAcpLog, type RawAcpEvent } from './raw-log';

export interface AcpChatHistory {
  committed: TranscriptTurn[];
  active: TranscriptTurn | null;
}

export type SessionConfigCatalog =
  | { kind: 'pending' }
  | {
      kind: 'ready';
      config: Pick<SessionConfigState, 'options'>;
    };

export class SessionCell {
  readonly machine: SessionMachine;
  readonly transcript: AcpTranscriptParser;
  readonly rawLog: RawAcpLog;
  /** Diagnostics belong to this activation, not to transcript history or retained config. */
  readonly mcpStartupFailures = new Map<string, string>();
  private readonly permissions = new PermissionBroker();
  private _acpSessionId: string;
  private configCatalogState: SessionConfigCatalog['kind'] = 'pending';
  private quiesceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRunningAgentCount = 0;
  private readonly effectDriver: MachineEffectDriver<Effect>;
  private preparedPromptEffects: Effect[] | null = null;
  private disposed = false;

  constructor(private readonly deps: SessionCellDeps) {
    this._acpSessionId = deps.acpSessionId;
    this.machine = new SessionMachine(deps.conversationId);
    this.transcript = new AcpTranscriptParser({ conversationId: deps.conversationId });
    this.rawLog = new RawAcpLog({
      conversationId: deps.conversationId,
      providerId: deps.providerId,
      acpSessionId: deps.acpSessionId,
      createdAt: new Date().toISOString(),
    });
    this.effectDriver = createMachineEffectDriver({
      interpret: (effect) => this.interpretEffect(effect),
      onDrain: ({ effects }) => {
        if (effects.some(isSessionStateEffect)) {
          this.deps.callbacks?.onSessionStateChanged?.();
        }
      },
      onInterpreterError: ({ error, effect }) => {
        this.deps.logger.warn('SessionCell: effect handler failed', {
          conversationId: this.conversationId,
          effect,
          error,
        });
      },
    });
  }

  get conversationId(): string {
    return this.deps.conversationId;
  }

  get acpSessionId(): string {
    return this._acpSessionId;
  }

  setAcpSessionId(sessionId: string): void {
    this._acpSessionId = sessionId;
    this.rawLog.setAcpSessionId(sessionId);
  }

  get sessionState(): SessionState {
    const state = this.machine.sessionState();
    return {
      ...state,
      // Partial replay is never an authoritative transcript position.
      transcript: state.lifecycle === 'replaying' ? null : this.transcript.snapshot,
    };
  }

  get config(): SessionConfigState {
    return this.transcript.config;
  }

  get configCatalog(): SessionConfigCatalog {
    if (this.configCatalogState === 'pending') return { kind: 'pending' };
    const { options } = this.config;
    return {
      kind: 'ready',
      config: { options },
    };
  }

  get usage(): SessionUsage | null {
    return this.transcript.usage;
  }

  history(): AcpChatHistory {
    return {
      committed: structuredClone([...this.transcript.history]),
      active: this.transcript.activeTurn ? structuredClone(this.transcript.activeTurn) : null,
    };
  }

  exportParsedTranscript(): string {
    const history = this.history();
    return JSON.stringify(
      {
        meta: {
          conversationId: this.conversationId,
          providerId: this.deps.providerId,
          acpSessionId: this.acpSessionId,
          exportedAt: new Date().toISOString(),
        },
        committed: history.committed,
        active: history.active,
      },
      null,
      2
    );
  }

  recordRaw(event: RawAcpEvent): void {
    this.rawLog.record(event);
  }

  exportRawLog(): string {
    return this.rawLog.exportJson();
  }

  beginReplay(at = Date.now()): void {
    this.applyEvent({ type: 'ReplayStarted' });
    this.transcript.beginReplay(at);
    this.lastRunningAgentCount = 0;
  }

  prepareActivation(
    initialQueue: readonly PromptInput[],
    resumed: boolean
  ): Result<() => void, InvalidStateError> {
    if (this.preparedPromptEffects) {
      return acpErr.invalidState('Session activation is already prepared.');
    }
    const effects: Effect[] = [];
    this.preparedPromptEffects = effects;
    for (const prompt of initialQueue) {
      const queued = this.queuePrompt(prompt);
      if (!queued.success) return queued;
    }
    if (resumed) this.endReplay();
    else this.applySessionReady();
    return ok(() => {
      if (this.preparedPromptEffects !== effects) return;
      this.preparedPromptEffects = null;
      this.interpretEffects(effects);
    });
  }

  endReplay(at = Date.now()): void {
    const previousRunningAgentCount = this.lastRunningAgentCount;
    // A resumed session runs in a new agent process, so background agents the replayed history
    // still shows as running belonged to the old process and will never report back. Left
    // running, they would pin the session as generating. Their real outcome is unknown; they
    // are marked completed rather than failed so finished work isn't shown as an error.
    this.settleRunningAgents('all', 'completed');
    this.transcript.endReplay(at);
    this.dispatchAgentsChangedIfNeeded(previousRunningAgentCount);
    this.applyEvent({ type: 'ReplayEnded', status: 'complete' });
    this.emitTranscriptChanged();
  }

  applySessionReady(meta?: { configOptions?: readonly SessionConfigOption[] | null }): void {
    this.applyEvent({ type: 'SessionReady' });
    this.seedTranscriptMeta(meta, 'complete');
  }

  applySessionLoaded(meta?: { configOptions?: readonly SessionConfigOption[] | null }): void {
    this.applyEvent({ type: 'SessionLoaded' });
    this.seedTranscriptMeta(meta, 'complete');
  }

  applySessionMeta(meta: { configOptions?: readonly SessionConfigOption[] | null }): void {
    this.seedTranscriptMeta(meta);
  }

  push(event: NormalizedEvent): void {
    if (event.kind === 'ignored') return;
    if (event.kind === 'mcp_startup_failure') {
      this.mcpStartupFailures.set(event.server, event.error);
      this.deps.callbacks?.onSessionStateChanged?.();
      return;
    }

    const idleTranscriptEvent = this.isIdleAgentTranscriptEvent(event);
    if (idleTranscriptEvent) this.applyEvent({ type: 'AgentActivity', active: true });

    if (this.isTranscriptEvent(event) && !this.canAcceptTranscriptEvent()) {
      this.deps.logger.warn('SessionCell: dropping transcript update outside active turn', {
        conversationId: this.conversationId,
        phase: this.machine.phase.kind,
      });
      return;
    }

    const previousRunningAgentCount = this.lastRunningAgentCount;
    this.transcript.pushEvent(event);
    if (event.kind === 'config') this.configCatalogState = 'ready';
    this.dispatchAgentsChangedIfNeeded(previousRunningAgentCount);
    if (idleTranscriptEvent) this.scheduleQuiesce();
    this.emitTranscriptChanged();
  }

  async prompt(
    input: PromptInput,
    acceptance?: PromptAcceptance
  ): Promise<Result<SessionPromptResult, AcpSendPromptError>> {
    const now = Date.now();
    const result = await this.sendPromptInternal(
      {
        id: acceptance?.id ?? crypto.randomUUID(),
        ...input,
        createdAt: now,
        updatedAt: now,
      },
      acceptance
    );
    return result;
  }

  /**
   * While busy: folds queued prompts and `input` into one queued prompt and cancels the active
   * turn, so it runs as soon as the turn ends. While idle, or only background agents are running:
   * sends `input` like `prompt` (a message doesn't stop background agents; Stop does).
   */
  async interrupt(
    input: PromptInput,
    acceptance?: PromptAcceptance
  ): Promise<Result<SessionPromptResult, AcpSendPromptError>> {
    if (!this.machine.isForegroundBusy) return this.prompt(input, acceptance);
    if (
      this.deps.supportsSteering &&
      this.machine.phase.kind === 'working' &&
      (await this.steer(input, acceptance))
    ) {
      return ok({ queued: false });
    }
    const alreadyCancelling = this.machine.phase.kind === 'cancelling';
    const now = Date.now();
    const dispatched = this.dispatchFor<InvalidStateError>(
      {
        type: 'InterruptWithPrompt',
        prompt: {
          id: acceptance?.id ?? crypto.randomUUID(),
          ...input,
          createdAt: now,
          updatedAt: now,
        },
      },
      ['invalid_state']
    );
    if (!dispatched.success) return dispatched;
    acceptance?.onAccepted({ queued: true });
    if (!alreadyCancelling) {
      try {
        await this.deps.agent.cancel({ sessionId: this.acpSessionId });
      } catch (error) {
        // The merged prompt is already queued; it runs whenever the turn does end.
        this.deps.logger.warn('SessionCell: failed to cancel turn for interrupt', {
          conversationId: this.conversationId,
          error,
        });
      }
    }
    return ok({ queued: true });
  }

  /**
   * Hands the queue plus `input` to the agent inside its running turn, so it decides what to
   * stop, redirect, or let finish instead of everything being cancelled. Returns false (with
   * nothing changed) when the agent doesn't take it, e.g. its turn has just ended.
   */
  private async steer(input: PromptInput, acceptance?: PromptAcceptance): Promise<boolean> {
    const extMethod = this.deps.agent.extMethod?.bind(this.deps.agent);
    if (!extMethod) return false;
    const now = Date.now();
    const id = acceptance?.id ?? crypto.randomUUID();
    const queued = this.machine.queuedPrompts;
    const prompt = mergeQueuedPrompts([
      ...queued,
      { id, ...input, createdAt: now, updatedAt: now },
    ]);
    let content;
    try {
      const resolved = await Promise.all(
        (prompt.attachments ?? []).map((attachment) =>
          this.deps.resolveAttachment(this.deps.conversationId, attachment)
        )
      );
      content = promptContent(prompt, resolved);
      const response = await extMethod('_session/steering', {
        sessionId: this.acpSessionId,
        prompt: content,
        _meta: { steering: { idleBehavior: 'promptRequired' } },
      });
      if (response.outcome !== 'injected') return false;
    } catch (error) {
      this.deps.logger.warn('SessionCell: steering failed; falling back to interrupt', {
        conversationId: this.conversationId,
        error,
      });
      return false;
    }
    this.rawLog.record({ kind: 'prompt', sessionId: this.acpSessionId, content });
    for (const queuedPrompt of queued) {
      this.dispatchFor<InvalidStateError>({ type: 'RemoveQueuedPrompt', id: queuedPrompt.id }, [
        'invalid_state',
      ]);
    }
    this.transcript.pushEvent({
      kind: 'message',
      role: 'user',
      messageId: `${this.conversationId}-steer-${id}`,
      promptId: id,
      text: prompt.text,
      ...(prompt.attachments?.length
        ? {
            attachments: prompt.attachments.map((attachment, index) => ({
              id: attachment.id,
              name: attachment.name ?? `image-${index + 1}`,
              mimeType: attachment.mimeType,
            })),
          }
        : {}),
    });
    this.emitTranscriptChanged();
    acceptance?.onAccepted({ queued: false });
    return true;
  }

  queuePrompt(
    input: PromptInput,
    id: string = crypto.randomUUID()
  ): Result<void, InvalidStateError> {
    const now = Date.now();
    const result = this.dispatchFor<InvalidStateError>(
      {
        type: 'QueuePrompt',
        prompt: {
          id,
          ...input,
          createdAt: now,
          updatedAt: now,
        },
      },
      ['invalid_state']
    );
    if (!result.success) return result;
    return ok();
  }

  editQueuedPrompt(id: string, input: PromptInput): Result<void, InvalidStateError> {
    const result = this.dispatchFor<InvalidStateError>(
      {
        type: 'EditQueuedPrompt',
        id,
        input,
        updatedAt: Date.now(),
      },
      ['invalid_state']
    );
    if (!result.success) return result;
    return ok();
  }

  removeQueuedPrompt(id: string): Result<void, InvalidStateError> {
    const result = this.dispatchFor<InvalidStateError>({ type: 'RemoveQueuedPrompt', id }, [
      'invalid_state',
    ]);
    if (!result.success) return result;
    return ok();
  }

  reorderQueue(ids: readonly string[]): Result<void, InvalidStateError> {
    const result = this.dispatchFor<InvalidStateError>({ type: 'ReorderQueue', ids }, [
      'invalid_state',
    ]);
    if (!result.success) return result;
    return ok();
  }

  async cancel(): Promise<Result<void, AcpCancelTurnError>> {
    const dispatchResult = this.dispatchFor<AcpCancelTurnError>({ type: 'Cancel' }, [
      'invalid_state',
    ]);
    if (!dispatchResult.success) return dispatchResult;
    try {
      await this.deps.agent.cancel({ sessionId: this.acpSessionId });
      return ok();
    } catch (e) {
      return acpErr.cancelFailed(toSerializedError(e));
    }
  }

  async closeSession(): Promise<void> {
    if (!this.deps.agent.closeSession) return;
    await this.deps.agent.closeSession({ sessionId: this.acpSessionId });
  }

  resolvePermission(requestId: string, optionId: string): Result<void, InvalidStateError> {
    if (!this.machine.pendingPermissions.some((p) => p.requestId === requestId)) {
      return acpErr.invalidState(`No resolver for requestId '${requestId}'`);
    }
    const dispatchResult = this.dispatchFor<InvalidStateError>(
      { type: 'ResolvePermission', requestId, optionId },
      ['invalid_state']
    );
    if (!dispatchResult.success) return dispatchResult;
    this.rawLog.record({
      kind: 'permission_resolved',
      sessionId: this.acpSessionId,
      requestId,
      optionId,
    });
    this.permissions.settle(requestId, optionId);
    return ok();
  }

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = crypto.randomUUID();
    const request: AcpPermissionRequest = {
      requestId,
      toolCall: this.buildPermissionToolCall(requestId, params.toolCall),
      options: params.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
    };
    this.rawLog.record({
      kind: 'permission_request',
      sessionId: params.sessionId,
      request: params,
    });
    this.applyEvent({ type: 'PermissionRequested', request });
    return this.permissions.request(request);
  }

  async setOption(
    configId: string,
    value: string | boolean
  ): Promise<Result<void, AcpSetOptionError>> {
    const option = this.config.options?.find((item) => item.id === configId);
    if (!option || !acceptsProviderValue(option, value)) {
      return acpErr.setConfigFailed({
        name: 'UnsupportedOption',
        message: `Unsupported value for ${configId}`,
      });
    }
    const allowed = this.dispatchFor<AcpSetOptionError>(
      { type: 'SetConfigOption', configId, value },
      ['invalid_state', 'set_config_failed']
    );
    if (!allowed.success) return allowed;
    if (!this.deps.agent.setSessionConfigOption) {
      return acpErr.setConfigFailed({
        name: 'UnsupportedOption',
        message: 'Agent does not support configuration updates',
      });
    }
    try {
      const response = await this.deps.agent.setSessionConfigOption({
        sessionId: this.acpSessionId,
        configId,
        ...(typeof value === 'boolean' ? { type: 'boolean', value } : { value }),
      } satisfies SetSessionConfigOptionRequest);
      this.seedTranscriptMeta({ configOptions: response.configOptions });
      return ok();
    } catch (error) {
      return acpErr.setConfigFailed(toSerializedError(error));
    }
  }

  settleTurn(outcome: TranscriptTurnOutcome): void {
    const previousRunningAgentCount = this.lastRunningAgentCount;
    const endingTurnId = this.transcript.activeTurn?.id ?? null;
    this.transcript.settleTurn(outcome);
    this.settleEarlierBackgroundAgents(endingTurnId);
    this.dispatchAgentsChangedIfNeeded(previousRunningAgentCount);
    this.emitTranscriptChanged();
    this.applyEvent({ type: 'TurnEnded', outcome: machineOutcome(outcome) });
  }

  processClosed(exitCode: number | null): void {
    this.clearQuiesce();
    this.applyEvent({ type: 'ProcessClosed', exitCode });
  }

  dispose(): void {
    this.disposed = true;
    this.clearQuiesce();
    this.preparedPromptEffects = null;
    this.effectDriver.dispose();
    this.permissions.drain(this.machine.pendingPermissions);
  }

  private dispatch(command: Command): Result<Effect[], AcpRuntimeError> {
    const result = this.machine.dispatch(command, this.context());
    if (!result.success) return result;
    this.interpretEffects(result.data);
    return result;
  }

  private dispatchFor<E extends AcpRuntimeError>(
    command: Command,
    expected: readonly E['type'][]
  ): Result<Effect[], E> {
    const result = this.dispatch(command);
    if (result.success) return result;
    if (expected.includes(result.error.type as E['type'])) return result as Result<Effect[], E>;
    throw new Error(`Unexpected ACP dispatch error '${result.error.type}'`);
  }

  private applyEvent(event: DomainEvent): void {
    this.interpretEffects(this.machine.apply(event));
  }

  private interpretEffects(effects: readonly Effect[]): void {
    this.effectDriver.run(effects);
  }

  private interpretEffect(effect: Effect): void {
    switch (effect.type) {
      case 'state':
      case 'permissionRequest':
        break;
      case 'permissionResolved':
        if (effect.cancelled) this.permissions.cancel(effect.requestId);
        break;
      case 'closed':
        this.deps.callbacks?.onClosed?.(effect.exitCode);
        break;
      case 'agentEvent':
        this.deps.callbacks?.onAgentEvent?.(effect.phase);
        break;
      case 'settleAgents':
        this.settleRunningAgents(effect.scope, effect.status);
        break;
      case 'sendPrompt':
        if (this.preparedPromptEffects) {
          this.preparedPromptEffects.push(effect);
          break;
        }
        this.deps.callbacks?.onSendQueuedPrompt?.(effect.prompt);
        void this.sendPromptInternal(effect.prompt).then(
          (result) => {
            if (!result.success) {
              this.deps.logger.warn('SessionCell: failed to send queued prompt', {
                conversationId: this.conversationId,
                error: result.error,
              });
            }
          },
          (error: unknown) => {
            this.deps.logger.error('SessionCell: queued prompt execution failed', {
              conversationId: this.conversationId,
              error,
            });
          }
        );
        break;
      case 'warn':
        this.deps.logger.warn(`SessionCell: ${effect.message}`, {
          conversationId: this.conversationId,
        });
        break;
    }
  }

  /**
   * Resolves a queued prompt's images. A queued prompt can hold several messages, so an image
   * that can no longer be loaded is left out (and the agent told) rather than failing them all.
   */
  private async resolveQueuedAttachments(prompt: QueuedPrompt): Promise<{
    content: Pick<QueuedPrompt, 'text' | 'attachments' | 'hiddenContext'>;
    resolved: ResolvedImage[];
  }> {
    const attachments = prompt.attachments ?? [];
    const settled = await Promise.allSettled(
      attachments.map((attachment) =>
        this.deps.resolveAttachment(this.deps.conversationId, attachment)
      )
    );
    const kept = attachments.filter((_, index) => settled[index]!.status === 'fulfilled');
    const resolved = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    );
    const missing = attachments.length - kept.length;
    if (missing === 0) return { content: prompt, resolved };
    this.deps.logger.warn('SessionCell: leaving out queued images that could not be loaded', {
      conversationId: this.conversationId,
      missing,
    });
    const note = `${missing} image(s) attached to this message could not be loaded and were left out.`;
    return {
      content: {
        text: prompt.text,
        attachments: kept,
        hiddenContext: [prompt.hiddenContext, note].filter(Boolean).join('\n\n'),
      },
      resolved,
    };
  }

  private async sendPromptInternal(
    prompt: QueuedPrompt,
    acceptance?: PromptAcceptance
  ): Promise<Result<SessionPromptResult, AcpSendPromptError>> {
    const decision = this.dispatchFor<AcpSendPromptError>({ type: 'Prompt', prompt }, [
      'invalid_state',
    ]);
    if (!decision.success) return decision;
    const started = decision.data.some(
      (effect) => effect.type === 'agentEvent' && effect.phase === 'start'
    );
    if (!started) {
      acceptance?.onAccepted({ queued: true });
      return ok({ queued: true });
    }

    const messageId = `${this.conversationId}-${this.machine.nextTurnIndex}-user`;
    this.transcript.pushEvent({
      kind: 'message',
      role: 'user',
      messageId,
      promptId: prompt.id,
      text: prompt.text,
      ...(prompt.attachments?.length
        ? {
            attachments: prompt.attachments.map((attachment, index) => ({
              id: attachment.id,
              name: attachment.name ?? `image-${index + 1}`,
              mimeType: attachment.mimeType,
            })),
          }
        : {}),
    });
    this.emitTranscriptChanged();

    let outcome: TranscriptTurnOutcome;
    let result: Result<SessionPromptResult, AcpSendPromptError>;
    try {
      const { content: sendable, resolved: resolvedAttachments } = acceptance?.resolvedAttachments
        ? { content: prompt, resolved: acceptance.resolvedAttachments }
        : await this.resolveQueuedAttachments(prompt);
      const promptRequest = {
        sessionId: this.acpSessionId,
        prompt: promptContent(sendable, resolvedAttachments),
      };
      this.rawLog.record({
        kind: 'prompt',
        sessionId: this.acpSessionId,
        content: promptRequest.prompt,
      });
      acceptance?.onAccepted({ queued: false });
      const response = await this.deps.agent.prompt(promptRequest);
      this.rawLog.record({
        kind: 'prompt_result',
        sessionId: this.acpSessionId,
        stopReason: response.stopReason,
      });
      outcome = outcomeFromStopReason(response.stopReason);
      result = ok({ queued: false });
    } catch (e) {
      this.rawLog.record({
        kind: 'prompt_result',
        sessionId: this.acpSessionId,
        stopReason: null,
      });
      outcome = { kind: 'error', reason: 'prompt_failed' };
      result = acpErr.promptFailed(toSerializedError(e));
    }
    // Teardown is bounded, so the provider can answer after this activation was disposed.
    if (this.disposed) {
      this.deps.logger.debug('SessionCell: provider answered after the activation ended', {
        conversationId: this.conversationId,
        outcome,
      });
      return result;
    }
    this.settleTurn(outcome);
    return result;
  }

  private seedTranscriptMeta(
    meta?: {
      configOptions?: readonly SessionConfigOption[] | null;
    },
    catalogBoundary: 'incremental' | 'complete' = 'incremental'
  ): void {
    if (!meta && catalogBoundary === 'incremental') return;
    const configOptions = meta?.configOptions;
    const completesCatalog =
      configOptions !== undefined ||
      (catalogBoundary === 'complete' && this.configCatalogState === 'pending');
    if (completesCatalog) {
      this.transcript.pushEvent({
        kind: 'config',
        options: configOptions ?? [],
      });
      this.configCatalogState = 'ready';
    }
    if (completesCatalog) {
      this.emitTranscriptChanged();
    }
  }

  private dispatchAgentsChangedIfNeeded(previousRunningAgentCount: number): void {
    const nextRunningAgentCount = this.transcript.agents.filter(
      (agent) => agent.background === true && agent.status === 'running'
    ).length;
    if (nextRunningAgentCount === previousRunningAgentCount) return;
    this.lastRunningAgentCount = nextRunningAgentCount;
    this.applyEvent({ type: 'AgentsChanged', runningCount: nextRunningAgentCount });
  }

  private settleRunningAgents(scope: 'turn' | 'all', status: 'completed' | 'failed'): void {
    const runningAgents = this.transcript.agents.filter((agent) => {
      if (agent.status !== 'running') return false;
      return scope === 'all' || agent.background !== true;
    });

    for (const agent of runningAgents) {
      this.push({
        kind: 'subagent_update',
        agentId: agent.agentId,
        toolCallId: agent.toolCallId,
        status,
      });
    }
  }

  /**
   * Marks background agents launched before the turn that just ended as completed. Claude reports
   * a background agent's completion as its own notification turn only when the agent finishes
   * while the session is idle; one that finishes during a turn is handed to the model inside that
   * turn with nothing on the ACP stream, and would otherwise stay running (and keep the session
   * generating) forever. A turn ending after the launch turn is the last point its completion
   * could have gone unreported. An agent genuinely still running then shows completed early; its
   * real completion still arrives later as a notification turn.
   */
  private settleEarlierBackgroundAgents(endingTurnId: string | null): void {
    const stale = this.transcript.agents.filter(
      (agent) =>
        agent.background === true &&
        agent.status === 'running' &&
        agent.launchTurnId !== endingTurnId
    );
    for (const agent of stale) {
      this.push({
        kind: 'subagent_update',
        agentId: agent.agentId,
        toolCallId: agent.toolCallId,
        status: 'completed',
      });
    }
  }

  private scheduleQuiesce(): void {
    if (this.quiesceTimer) clearTimeout(this.quiesceTimer);
    this.quiesceTimer = setTimeout(() => {
      this.quiesceTimer = null;
      if (!this.machine.agentTurnActive) return;
      const endingTurnId = this.transcript.activeTurn?.id ?? null;
      this.transcript.settleTurn({ kind: 'done', reason: 'quiesced' });
      this.settleEarlierBackgroundAgents(endingTurnId);
      this.emitTranscriptChanged();
      this.applyEvent({ type: 'AgentActivity', active: false });
    }, 250);
  }

  private clearQuiesce(): void {
    if (!this.quiesceTimer) return;
    clearTimeout(this.quiesceTimer);
    this.quiesceTimer = null;
  }

  private context(): SessionMachineContext {
    return {
      configOptionIds: (this.config.options ?? []).map((option) => option.id),
    };
  }

  private isTranscriptEvent(event: NormalizedEvent): boolean {
    switch (event.kind) {
      case 'notification':
      case 'message':
      case 'thinking':
      case 'tool_call':
      case 'tool_update':
      case 'subagent':
      case 'search':
      case 'mcp_tool':
      case 'web_fetch':
      case 'plan':
        return true;
      default:
        return false;
    }
  }

  private isIdleAgentTranscriptEvent(event: NormalizedEvent): boolean {
    return (
      this.machine.phase.kind === 'ready' &&
      this.transcript.advancesForeground(event) &&
      !(event.kind === 'message' && event.role === 'user')
    );
  }

  private canAcceptTranscriptEvent(): boolean {
    return (
      this.machine.phase.kind === 'working' ||
      this.machine.phase.kind === 'replaying' ||
      this.machine.phase.kind === 'ready' ||
      this.machine.agentTurnActive
    );
  }

  private buildPermissionToolCall(
    requestId: string,
    rawToolCall: RequestPermissionRequest['toolCall'] | undefined
  ): ToolCallItem {
    const activeTurn = this.transcript.activeTurn;
    const toolCallId = rawToolCall?.toolCallId ?? requestId;
    if (activeTurn) {
      const id = makeToolId(activeTurn.id, toolCallId);
      const existing = findToolCall(activeTurn.items, id, toolCallId);
      if (existing) return structuredClone(existing);
    }

    return createToolCallItem({
      id: activeTurn ? makeToolId(activeTurn.id, toolCallId) : `permission:${toolCallId}`,
      seq: 0,
      toolCallId,
      title: rawToolCall?.title ?? 'Permission request',
      toolKind: rawToolCall?.kind ?? null,
      status: 'pending',
      parentToolCallId: undefined,
    });
  }

  private emitTranscriptChanged(): void {
    this.deps.callbacks?.onTranscriptChanged?.();
  }
}

function findToolCall(
  items: Array<ToolNode | { kind: string; id: string }>,
  id: string,
  toolCallId: string
): ToolCallItem | undefined {
  for (const item of items) {
    if (item.kind.endsWith('-tool-call') && 'toolCallId' in item) {
      if (item.id === id || item.toolCallId === toolCallId) return item as ToolCallItem;
      const found = findToolCall((item as ToolCallItem).children ?? [], id, toolCallId);
      if (found) return found;
    } else if (item.kind === 'tool-group' && 'children' in item) {
      const found = findToolCall(item.children as ToolNode[], id, toolCallId);
      if (found) return found;
    }
  }
  return undefined;
}

function machineOutcome(
  outcome: TranscriptTurnOutcome
): { kind: 'stopped'; stopReason: StopReason } | { kind: 'errored' } {
  if (outcome.kind === 'error') return { kind: 'errored' };
  if (outcome.kind === 'cancelled') return { kind: 'stopped', stopReason: 'cancelled' };
  return { kind: 'stopped', stopReason: toStopReason(outcome.reason) };
}

function outcomeFromStopReason(stopReason: StopReason): TranscriptTurnOutcome {
  if (stopReason === 'cancelled') return { kind: 'cancelled', reason: stopReason };
  return { kind: 'done', reason: stopReason };
}

function isSessionStateEffect(effect: Effect): boolean {
  return (
    effect.type === 'state' ||
    effect.type === 'permissionRequest' ||
    effect.type === 'permissionResolved'
  );
}

function toStopReason(reason: TranscriptTurnOutcome['reason']): StopReason {
  switch (reason) {
    case 'cancelled':
    case 'end_turn':
    case 'max_tokens':
    case 'max_turn_requests':
    case 'refusal':
      return reason;
    default:
      return 'end_turn';
  }
}

export { SESSION_PLAN_ID };

type ResolvedImage = { data: string; mimeType: string };

/**
 * Image blocks for a prompt. An image the text refers to by its label (an attachment named
 * "Image 1" referenced as "[Image 1]") is preceded by that label, so the agent can tell which
 * image the text means. Labels are hidden-context blocks, which transcripts drop on replay.
 */
export function promptImageBlocks(
  text: string | undefined,
  attachments: readonly { name?: string }[],
  resolved: readonly ResolvedImage[]
) {
  return resolved.flatMap((image, index) => {
    const name = attachments[index]?.name;
    const label = name && text?.includes(`[${name}]`) ? `[${name}]` : null;
    return [
      ...(label ? [{ type: 'text' as const, text: wrapHiddenContext(label) }] : []),
      { type: 'image' as const, data: image.data, mimeType: image.mimeType },
    ];
  });
}

/** ACP prompt content for a prompt: labelled images, its text, then any hidden context. */
function promptContent(
  prompt: Pick<QueuedPrompt, 'text' | 'attachments' | 'hiddenContext'>,
  resolved: readonly ResolvedImage[]
) {
  return [
    ...promptImageBlocks(prompt.text, prompt.attachments ?? [], resolved),
    ...(prompt.text ? [{ type: 'text' as const, text: prompt.text }] : []),
    ...(prompt.hiddenContext
      ? [{ type: 'text' as const, text: wrapHiddenContext(prompt.hiddenContext) }]
      : []),
  ];
}
