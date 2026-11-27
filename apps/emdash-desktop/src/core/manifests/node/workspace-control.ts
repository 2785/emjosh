import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { formatHostRef, LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import type { Logger } from '@emdash/shared/logger';
import type { ContractClient } from '@emdash/wire/rpc';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry/conversation-registry';
import { getProviderSettingsService } from '@core/features/conversations/node/provider-settings-service';
import {
  sendAcpConversationPrompt,
  startAcpConversationSession,
} from '@core/features/conversations/node/wire-controller';
import type { InitiativeMessage } from '@core/features/initiatives/api/contract';
import { formatInitiativeDelivery } from '@core/features/initiatives/api/delivery';
import { workspaceRef } from '@core/features/initiatives/api/labels';
import { describeAgentEvent } from '@core/features/initiatives/node/agent-events';
import {
  DEFAULT_DELIVERY_WINDOW,
  DeliveryCoalescer,
} from '@core/features/initiatives/node/delivery-coalescer';
import { createProjectOperations } from '@core/features/projects/node/controller';
import { createProjectFromRemote } from '@core/features/projects/node/operations/create-project-from-remote';
import { formatTaskDisplayName, normalizeTaskName } from '@core/features/tasks/api/task-names';
import { generateRandom } from '@core/features/tasks/node/name-generation/generateTaskName';
import { AppApi, appApiCatalog, type AppWire } from '@core/features/workspace-control/node/app-api';
import {
  startControlMcpEndpoint,
  type ControlMcpEndpoint,
} from '@core/features/workspace-control/node/mcp-endpoint';
import { hasGitRemote } from '@core/features/workspace-control/node/repository-remotes';
import {
  type ControlPullRequest,
  humanizeSlug,
  type WorkspaceControlDeps,
  WorkspaceControlService,
} from '@core/features/workspace-control/node/workspace-control-service';
import { setWorkspaceSearch } from '@core/features/workspace-control/node/workspace-search-registry';
import { WorkspaceSearchService } from '@core/features/workspace-control/node/workspace-search-service';
import {
  checkedOutBranch,
  isAncestor,
  worktreeTip,
} from '@core/features/workspace-control/node/worktree-branches';
import { workspaceRegistryTable as workspaces } from '@core/features/workspaces/api/node/registry/workspace-registry';
import { getProvisionedWorkspaceBranch } from '@core/features/workspaces/api/node/workspace-branch';
import { desktopWireContract } from '@core/manifests/shared/desktop-wire-contract';
import type { Project } from '@core/primitives/projects/api';
import { resolveTaskBranchName } from '@core/primitives/tasks/api/resolve-task-branch-name';
import { buildWorkspaceConfigFromPreset } from '@core/primitives/workspaces/api/build-workspace-config-from-preset';
import { initiativeMessages, projects, tasks } from '@core/services/app-db/node/schema';
import { selectCurrentPr } from '@core/services/pull-requests/api';
import type { PullRequestsContract } from '@core/services/pull-requests/api/contract';
import type { PullRequestsRegistration } from '@core/services/pull-requests/node/pull-requests-registration';
import type { DesktopControllerContext } from './controllers';
import { getInitiativesService } from './initiatives';

const execFileAsync = promisify(execFile);

const AGENT_STATUS_RANK: Record<string, number> = {
  'awaiting-input': 5,
  working: 4,
  error: 3,
  background: 2,
  completed: 1,
  idle: 0,
};

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** How often the app re-checks whether workspaces that others depend on look done. */
const DEPENDENCY_CHECK_INTERVAL_MS = 5 * 60_000;

/** The branch new work starts from: the remote's HEAD branch, else the current branch. */
async function defaultBaseBranch(repoPath: string, remoteName: string) {
  const remoteHead = await git(repoPath, ['symbolic-ref', `refs/remotes/${remoteName}/HEAD`]);
  const remoteUrl = await git(repoPath, ['remote', 'get-url', remoteName]);
  if (remoteHead && remoteUrl) {
    return {
      type: 'remote' as const,
      branch: remoteHead.replace(`refs/remotes/${remoteName}/`, ''),
      remote: { name: remoteName, url: remoteUrl },
    };
  }
  const current = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return current ? { type: 'local' as const, branch: current } : null;
}

function toControlPr(pr: {
  url: string;
  title: string;
  status: string;
  isDraft: boolean;
  identifier: string | null;
}): ControlPullRequest {
  const number = Number(pr.identifier?.replace(/^\D+/, ''));
  return {
    url: pr.url,
    title: pr.title,
    ...(Number.isFinite(number) && number > 0 ? { number } : {}),
    state:
      pr.status === 'open' && pr.isDraft ? 'draft' : (pr.status as ControlPullRequest['state']),
  };
}

/** Where chat transcripts are kept on this machine. */
export type TranscriptDirs = {
  /** The ACP runtime's per-conversation history cache (recent turns, any provider). */
  acpHistory: string;
  /** Claude Code's session logs (`~/.claude/projects`), full transcripts of claude chats. */
  claudeProjects: string;
};

/** The transcript files of one conversation, most complete first. */
export function transcriptPaths(
  dirs: TranscriptDirs,
  conversation: {
    id: string;
    provider: string | null;
    cwd: string | null;
    sessionId: string | null;
  }
): string[] {
  const paths: string[] = [];
  if (conversation.provider === 'claude' && conversation.cwd && conversation.sessionId) {
    // Claude Code names a project's directory after its path, every other character a dash.
    const project = conversation.cwd.replace(/[^a-zA-Z0-9]/g, '-');
    paths.push(join(dirs.claudeProjects, project, `${conversation.sessionId}.jsonl`));
  }
  paths.push(join(dirs.acpHistory, `${conversation.id.replace(/[^\w-]/g, '_')}.json`));
  return paths;
}

/** Starts the workspace control MCP endpoint over the app's own services. */
export async function startWorkspaceControl(
  context: DesktopControllerContext,
  extras: {
    pullRequests: ContractClient<PullRequestsContract>;
    pullRequestsRegistration: Pick<PullRequestsRegistration, 'repositoryUrlsForProject'>;
    /** The app's own wire, for the app API tools; without it they are unavailable. */
    appWire?: AppWire;
    /** Where the endpoint URL and token are published for local MCP clients. */
    endpointFile: string;
    version: string;
    logger: Logger;
    /** Transcripts the workspace search looks through; without them it skips chats. */
    transcripts?: TranscriptDirs;
    /** One tool-less run of a cheap model, for workspace search questions. */
    runSearchModel?(input: {
      system: string;
      prompt: string;
      signal?: AbortSignal;
    }): Promise<string>;
    /** Batching of initiative deliveries; DEFAULT_DELIVERY_WINDOW when omitted. */
    deliveryWindow?: Partial<typeof DEFAULT_DELIVERY_WINDOW>;
    /** Subscribes to live agent status events; returns the unsubscribe function. */
    onAgentEvent?(
      handler: (event: {
        type: string;
        taskId: string;
        payload?: { notificationType?: string };
      }) => void
    ): () => void;
  }
): Promise<ControlMcpEndpoint & { service: WorkspaceControlService }> {
  const { db, taskService, telemetry, appSettings } = context;
  const projectDependencies = {
    db,
    runtimes: context.runtimes,
    placement: context.workspacePlacement,
    projectDeletion: context.projectDeletion,
    projectSettings: context.projectSettings,
    projects: context.projects,
    mintCloneCredentials: context.gitCredentials.mintCloneCredentials,
  };
  const projectOperations = createProjectOperations(projectDependencies);
  const toControlProject = (project: Project) => ({
    id: project.id,
    name: project.name,
    path: project.path,
  });
  const failure = (error: { type: string; message?: string }) =>
    new Error(error.message ?? error.type);
  const log = extras.logger;
  const initiatives = getInitiativesService(db);

  const taskNames = async (ids: string[]) =>
    new Map(
      (ids.length
        ? await db
            .select({ id: tasks.id, name: tasks.name })
            .from(tasks)
            .where(inArray(tasks.id, ids))
        : []
      ).map((row) => [row.id, row.name])
    );

  /** The chat conversation a task's agent works in: its initial one, else its first. */
  const primaryConversation = async (taskId: string): Promise<string | null> => {
    const rows = await db
      .select({
        id: conversations.id,
        type: conversations.type,
        initial: conversations.isInitialConversation,
      })
      .from(conversations)
      .where(eq(conversations.taskId, taskId));
    const chats = rows.filter((row) => row.type === 'acp');
    return (chats.find((row) => row.initial) ?? chats[0])?.id ?? null;
  };

  // Push delivery: in an initiative with pushMessages on, messages that wake a task
  // (messageWakesTask) are fed into its chat in batches, labelled as coming from the feed rather
  // than the user. The rest only count towards the "quiet updates" note of its next delivery.
  const quietCounts = new Map<string, number>();
  const coalescer = new DeliveryCoalescer<InitiativeMessage>({
    ...DEFAULT_DELIVERY_WINDOW,
    ...extras.deliveryWindow,
    onError: (error) => log.warn('Initiative message delivery failed', { error }),
    async flush(taskId, messages) {
      const initiative = await initiatives.get(messages[0]!.initiativeId);
      if (!initiative?.pushMessages || initiative.archived) return;
      const conversationId = await primaryConversation(taskId);
      if (!conversationId) return;
      const names = await taskNames(
        messages.flatMap((message) => (message.fromTaskId ? [message.fromTaskId] : []))
      );
      const text = formatInitiativeDelivery({
        initiativeName: initiative.name,
        entries: messages.map((message) => ({
          kind: message.kind,
          sender: message.fromTaskId ? (names.get(message.fromTaskId) ?? 'unknown') : null,
          senderLabel: message.fromTaskId ? initiative.labels[message.fromTaskId] : undefined,
          senderId: message.fromTaskId ?? undefined,
          fromLead: message.fromTaskId !== null && message.fromTaskId === initiative.leadTaskId,
          direct: message.toTaskId === taskId,
          body: message.body,
        })),
        quietCount: quietCounts.get(taskId),
      });
      quietCounts.delete(taskId);
      // Into the running turn when the agent takes steering (Claude, Codex and Antigravity do);
      // otherwise it queues, and queued prompts run as one when the turn ends.
      const sent = await sendAcpConversationPrompt(context, conversationId, text, 'steer');
      if (!sent.success) log.warn('Initiative message delivery failed', { taskId });
    },
  });
  const deliver = async (message: InitiativeMessage) => {
    const initiative = await initiatives.get(message.initiativeId);
    if (!initiative?.pushMessages || initiative.archived) return;
    const { wake, quiet } = await initiatives.deliveryTargets(message);
    for (const taskId of quiet) quietCounts.set(taskId, (quietCounts.get(taskId) ?? 0) + 1);
    for (const taskId of wake) coalescer.add(taskId, message);
  };
  const stopDelivery = initiatives.onChange((change) => {
    if (change.type === 'message-posted') {
      deliver(change.message).catch((error: unknown) =>
        log.warn('Initiative message delivery failed', { error })
      );
    }
  });

  // App events: let a task's initiative know when its agent finishes, needs input, or fails.
  const stopEvents = extras.onAgentEvent?.((event) => {
    const described = describeAgentEvent(event);
    if (!described) return;
    void (async () => {
      const initiative = await initiatives.initiativeOfTask(event.taskId);
      if (!initiative || initiative.archived) return;
      const name = (await taskNames([event.taskId])).get(event.taskId) ?? 'unknown';
      await initiatives.post({
        initiativeId: initiative.id,
        fromTaskId: event.taskId,
        kind: described.kind,
        body: `${workspaceRef(name, initiative.labels[event.taskId], event.taskId)} ${described.what}.`,
      });
    })().catch((error: unknown) => log.warn('Initiative event failed', { error }));
  });

  const repositoryPath = async (projectId: string): Promise<string | null> => {
    const [row] = await db
      .select({ path: workspaces.path, location: workspaces.location })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.repositoryWorkspaceId))
      .where(eq(projects.id, projectId))
      .limit(1);
    return row?.location === 'remote' ? null : (row?.path ?? null);
  };

  /**
   * Where a local worktree workspace's branch is (see worktreeTip), with what it started from.
   */
  const workspaceTip = async (taskId: string) => {
    const [row] = await db
      .select({
        projectId: tasks.projectId,
        createdAt: tasks.createdAt,
        path: workspaces.path,
        location: workspaces.location,
        kind: workspaces.kind,
        config: workspaces.config,
      })
      .from(tasks)
      .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
      .where(eq(tasks.id, taskId))
      .limit(1);
    if (!row?.path || row.location === 'remote' || row.kind !== 'worktree') return null;
    const startedAt = Date.parse(row.createdAt.replace(' ', 'T') + 'Z') / 1000;
    const tip = await worktreeTip(row.path, startedAt);
    if (!tip) return null;
    const setup = row.config?.git;
    return {
      ...tip,
      projectId: row.projectId,
      path: row.path,
      fromBranch: setup?.kind === 'create-branch' ? setup.fromBranch : null,
    };
  };

  const deps: WorkspaceControlDeps = {
    async addProject({ path, name }) {
      const created = await projectOperations.createProject({ type: 'local', name, path });
      if (!created.success) throw failure(created.error);
      return toControlProject(created.data);
    },

    async cloneProject({ repositoryUrl, name, parentDirectory }) {
      const destination = await projectOperations.resolveRepositoryDestination({
        host: LOCAL_HOST_REF,
        name,
        chosenDir: parentDirectory,
      });
      if (!destination.success) throw failure(destination.error);
      // Not a UI job: progress and creation-state updates have no listener.
      const cloned = await createProjectFromRemote(
        projectDependencies,
        {
          projectId: crypto.randomUUID(),
          host: { type: 'local' },
          mode: 'clone',
          repositoryUrl,
          targetPath: destination.data,
          name,
        },
        { progress: () => {}, signal: new AbortController().signal } as never,
        () => {}
      );
      if (!cloned.success) throw failure(cloned.error);
      return toControlProject(cloned.data);
    },

    renameProject: (projectId, name) => projectOperations.renameProject(projectId, name),

    removeProject: (projectId) => projectOperations.deleteProject(projectId),

    async listProjects() {
      const rows = await db
        .select({ id: projects.id, name: projects.name, path: workspaces.path })
        .from(projects)
        .leftJoin(workspaces, eq(workspaces.id, projects.repositoryWorkspaceId))
        .where(isNull(projects.deletedAt));
      return rows.map((row) => ({ id: row.id, name: row.name, path: row.path ?? '' }));
    },

    async listWorkspaces({ projectId, includeArchived }) {
      const rows = await db
        .select({
          id: tasks.id,
          name: tasks.name,
          projectId: tasks.projectId,
          projectName: projects.name,
          archivedAt: tasks.archivedAt,
          lastInteractedAt: tasks.lastInteractedAt,
          workspaceKind: workspaces.kind,
          workspaceConfig: workspaces.config,
          initiativeId: tasks.initiativeId,
          label: tasks.initiativeLabel,
          status: tasks.status,
        })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .leftJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
        .where(
          and(
            isNull(tasks.deletedAt),
            isNull(projects.deletedAt),
            eq(tasks.type, 'task'),
            projectId ? eq(tasks.projectId, projectId) : undefined,
            includeArchived ? undefined : isNull(tasks.archivedAt)
          )
        )
        .orderBy(desc(tasks.lastInteractedAt));
      const statuses = rows.length
        ? await db
            .select({ taskId: conversations.taskId, status: conversations.agentStatus })
            .from(conversations)
            .where(
              inArray(
                conversations.taskId,
                rows.map((row) => row.id)
              )
            )
        : [];
      const statusByTask = new Map<string, string>();
      for (const { taskId, status } of statuses) {
        if (!taskId || !status) continue;
        const current = statusByTask.get(taskId);
        if (!current || (AGENT_STATUS_RANK[status] ?? 0) > (AGENT_STATUS_RANK[current] ?? 0)) {
          statusByTask.set(taskId, status);
        }
      }
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        projectId: row.projectId,
        projectName: row.projectName,
        branch: row.workspaceKind
          ? getProvisionedWorkspaceBranch({ kind: row.workspaceKind, config: row.workspaceConfig })
          : null,
        archived: row.archivedAt !== null,
        agentStatus: statusByTask.get(row.id) ?? null,
        lastActivityAt: row.lastInteractedAt,
        initiativeId: row.initiativeId,
        ...(row.initiativeId && row.label && { label: row.label }),
        markedDone: row.status === 'done',
      }));
    },

    async pullRequestForBranch(projectId, branch) {
      const repositoryUrls =
        await extras.pullRequestsRegistration.repositoryUrlsForProject(projectId);
      const found = [];
      for (const repositoryUrl of repositoryUrls) {
        const result = await extras.pullRequests.getPullRequestsForBranch({
          repositoryUrl,
          branch,
        });
        if (result.success) found.push(...result.data.prs);
      }
      const current = selectCurrentPr(found);
      return current ? toControlPr(current) : null;
    },

    async callerContext(conversationId) {
      const [row] = await db
        .select({
          taskId: conversations.taskId,
          provider: conversations.provider,
          config: conversations.config,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      if (!row?.taskId) return null;
      const options = row.config?.type === 'acp' ? row.config.options : undefined;
      return {
        taskId: row.taskId,
        provider: row.provider ?? 'claude',
        ...(options && { options }),
      };
    },

    async setWorkspaceDone(taskId, done) {
      await taskService.updateTaskStatus(taskId, done ? 'done' : 'in_progress', telemetry);
      checkDependencies();
    },

    async branchMergedInto(taskId) {
      const tip = await workspaceTip(taskId);
      if (!tip?.workedOn || !tip.fromBranch) return null;
      const base = tip.fromBranch;
      const candidates = [
        ...(base.remote ? [`refs/remotes/${base.remote.name}/${base.branch}`] : []),
        `refs/remotes/origin/${base.branch}`,
        `refs/heads/${base.branch}`,
      ];
      for (const ref of new Set(candidates)) {
        if (await isAncestor(tip.path, tip.sha, ref)) {
          return base.branch;
        }
      }
      return null;
    },

    async workspaceTip(taskId) {
      const tip = await workspaceTip(taskId);
      return (
        tip && {
          projectId: tip.projectId,
          path: tip.path,
          sha: tip.sha,
          workedOn: tip.workedOn,
          unsettled: tip.unsettled,
        }
      );
    },

    isAncestor,

    async uncommittedChanges(taskId) {
      const tip = await workspaceTip(taskId);
      if (!tip) throw new Error('The workspace has no local worktree.');
      const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: tip.path });
      return status.stdout.split('\n').filter((line) => line.trim().length > 0);
    },

    async commitLog(taskId) {
      const tip = await workspaceTip(taskId);
      if (!tip) return [];
      const base = tip.fromBranch;
      const bases = base
        ? [
            ...(base.remote ? [`refs/remotes/${base.remote.name}/${base.branch}`] : []),
            `refs/remotes/origin/${base.branch}`,
            `refs/heads/${base.branch}`,
          ]
        : [];
      // The first base ref that exists; without one, just its latest commits.
      for (const ref of [...bases, null]) {
        try {
          const { stdout } = await execFileAsync(
            'git',
            ['log', '-n', '30', '--format=%h %s', tip.sha, ...(ref ? ['--not', ref] : [])],
            { cwd: tip.path }
          );
          return stdout.split('\n').filter((line) => line.trim().length > 0);
        } catch {
          // Missing ref: try the next.
        }
      }
      return [];
    },

    async sendToWorkspaceChat(taskId, text) {
      const conversationId = await primaryConversation(taskId);
      if (!conversationId) return false;
      const sent = await sendAcpConversationPrompt(context, conversationId, text);
      return sent.success;
    },

    archiveWorkspace: (projectId, taskId) => taskService.archiveTask(projectId, taskId, telemetry),
    restoreWorkspace: (_projectId, taskId) => taskService.restoreTask(taskId),

    async renameWorkspace(projectId, taskId, name) {
      const result = await taskService.renameTask(projectId, taskId, name);
      if (!result.success) throw new Error(`Could not rename the workspace: ${result.error.type}`);
    },

    async createWorkspace(input) {
      const repoPath = await repositoryPath(input.projectId);
      if (!repoPath) throw new Error('Only local projects are supported for now.');
      const projectSettings = await appSettings.get('project');
      const fromBranch = input.baseBranch
        ? { type: 'local' as const, branch: input.baseBranch }
        : await defaultBaseBranch(repoPath, 'origin');
      if (!fromBranch) throw new Error('Could not determine a base branch; pass baseBranch.');
      const hasRemote = await hasGitRemote(repoPath);

      // The workspace shows the name as given; its branch needs the branch-safe form.
      const name = formatTaskDisplayName(humanizeSlug(input.name ?? '')) || generateRandom();
      const branchName = resolveTaskBranchName({
        rawBranch: normalizeTaskName(name) || generateRandom(),
        branchPrefix: projectSettings.branchPrefix,
        suffix: Math.random().toString(36).slice(2, 7),
        appendRandomSuffix: projectSettings.appendRandomBranchSuffix,
      });
      const provider = input.provider ?? (await appSettings.get('defaultAgent'));
      // Like the new-task dialog: start from the provider's saved preferences (such as the
      // permission mode the user picked), so the agent doesn't fall back to its own defaults.
      const preferences = await getProviderSettingsService(db).read({
        host: formatHostRef(LOCAL_HOST_REF),
        providerId: provider,
      });
      const options = { ...preferences.acp.options, ...input.options };
      const taskId = crypto.randomUUID();
      const prompt = input.prompt?.trim();
      const conversationId = crypto.randomUUID();

      const created = await taskService.createTask({
        id: taskId,
        projectId: input.projectId,
        taskConfig: {
          version: '1',
          name,
          ...(prompt
            ? {
                initialConversation: {
                  id: conversationId,
                  provider,
                  title: `${provider} (1)`,
                  initialQueue: [{ text: prompt }],
                  type: 'acp' as const,
                  ...(Object.keys(options).length > 0 && { options }),
                },
              }
            : {}),
        },
        workspaceConfig: buildWorkspaceConfigFromPreset(
          'new-worktree',
          { defaultBranch: fromBranch },
          // A repository without a remote has nowhere to push; asking to would fail provisioning.
          { branchName, fromBranch, pushBranch: hasRemote && (input.pushBranch ?? true) }
        ),
      });
      if (!created.success) {
        const detail = 'message' in created.error ? `: ${String(created.error.message)}` : '';
        throw new Error(`Could not create the workspace: ${created.error.type}${detail}`);
      }

      void (async () => {
        const provisioned = await taskService.provisionWorkspace(taskId);
        if (!provisioned.success) {
          log.warn('Workspace control: provisioning failed', { taskId, error: provisioned.error });
          return;
        }
        if (prompt) {
          const started = await startAcpConversationSession(context, conversationId);
          if (!started.success) {
            log.warn('Workspace control: first conversation did not start', { taskId });
          }
        }
      })().catch((error: unknown) =>
        log.warn('Workspace control: setup failed', { taskId, error })
      );

      return { id: taskId, name, branch: branchName };
    },
  };

  deps.initiatives = initiatives;
  if (extras.appWire) deps.appApi = new AppApi(appApiCatalog(desktopWireContract), extras.appWire);
  const service = new WorkspaceControlService(deps);

  const worktreePaths = async () =>
    new Map(
      (
        await db
          .select({ taskId: tasks.id, path: workspaces.path, location: workspaces.location })
          .from(tasks)
          .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
          .where(isNull(tasks.deletedAt))
      ).flatMap((row) => (row.path && row.location !== 'remote' ? [[row.taskId, row.path]] : []))
    );
  let pathsOfSearch: Promise<Map<string, string>> | null = null;
  const search = new WorkspaceSearchService({
    async listWorkspaces() {
      // Paths are read once per search, not once per workspace.
      pathsOfSearch = worktreePaths();
      return deps.listWorkspaces({ includeArchived: true });
    },
    pullRequestForBranch: deps.pullRequestForBranch,
    async initiativeNames() {
      const all = await initiatives.list({ includeArchived: true });
      return new Map(all.map((initiative) => [initiative.id, initiative.name]));
    },
    initiativeMessages: () =>
      db
        .select({ fromTaskId: initiativeMessages.fromTaskId, body: initiativeMessages.body })
        .from(initiativeMessages),
    async actualBranch(taskId) {
      const path = (await (pathsOfSearch ?? worktreePaths()))?.get(taskId);
      return path ? checkedOutBranch(path) : null;
    },
    transcriptFiles: extras.transcripts
      ? async (taskIds) => {
          const rows = taskIds.length
            ? await db
                .select({
                  id: conversations.id,
                  taskId: conversations.taskId,
                  provider: conversations.provider,
                  cwd: conversations.cwd,
                  sessionId: conversations.providerSessionId,
                })
                .from(conversations)
                .where(inArray(conversations.taskId, taskIds))
            : [];
          return rows.flatMap((row) =>
            row.taskId
              ? transcriptPaths(extras.transcripts!, row).map((path) => ({
                  workspaceId: row.taskId!,
                  path,
                }))
              : []
          );
        }
      : undefined,
    runModel: extras.runSearchModel,
  });
  setWorkspaceSearch(search);

  // Dependencies: dropped with archived or deleted workspaces; ones that look done (merged,
  // marked done) are announced to the lead on a timer and when a workspace's agent stops.
  function checkDependencies() {
    service
      .checkDependencies()
      .catch((error: unknown) => log.warn('Workspace dependency check failed', { error }));
  }
  const dropDependencies = (taskId: string) => {
    initiatives
      .removeDependencies([taskId])
      .catch((error: unknown) => log.warn('Dropping workspace dependencies failed', { error }));
  };
  const stopArchiveHook = taskService.on('task:archived', dropDependencies);
  const stopDeleteHook = taskService.on('task:deleted', dropDependencies);
  const stopStatusChecks = extras.onAgentEvent?.((event) => {
    if (event.type === 'stop') checkDependencies();
  });
  const dependencyTimer = setInterval(checkDependencies, DEPENDENCY_CHECK_INTERVAL_MS);
  dependencyTimer.unref?.();
  const endpoint = await startControlMcpEndpoint({
    service,
    endpointFile: extras.endpointFile,
    version: extras.version,
    onError: (error) => log.warn('Workspace control endpoint error', { error }),
  });
  return {
    info: endpoint.info,
    service,
    async close() {
      setWorkspaceSearch(null);
      stopDelivery();
      coalescer.dispose();
      stopEvents?.();
      stopStatusChecks?.();
      stopArchiveHook();
      stopDeleteHook();
      clearInterval(dependencyTimer);
      await endpoint.close();
    },
  };
}
