import type { Initiative, InitiativeMessage } from '@core/features/initiatives/api/contract';
import { ensureUniqueTaskDisplayName, isRandomTaskName } from '@core/features/tasks/api/task-names';

/**
 * Workspace control: what an agent (inside Emjosh today, any MCP client later) can do with
 * Emjosh's projects and workspaces. Transport-agnostic; the MCP endpoint is one adapter.
 * "Workspace" here is a task: a branch/worktree plus its conversations.
 */

export type ControlProject = { id: string; name: string; path: string };

export type ControlPullRequest = {
  url: string;
  number?: number;
  title: string;
  state: 'open' | 'merged' | 'closed' | 'draft';
};

export type ControlWorkspace = {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  branch: string | null;
  archived: boolean;
  agentStatus: string | null;
  lastActivityAt: string | null;
  initiativeId: string | null;
  pullRequest: ControlPullRequest | null;
};

export type CreateWorkspaceInput = {
  projectId: string;
  name?: string;
  baseBranch?: string;
  prompt?: string;
  /** Agent for the first conversation; defaults to the calling workspace's agent. */
  provider?: string;
  /** Initiative to put the new workspace in. */
  initiativeId?: string;
};

/** What a task listens to beyond messages addressed to it (see InitiativesService). */
export type InitiativeSubscription = {
  topic: 'messages' | 'events';
  sourceTaskId: string | null;
};

type SubscriptionChange = {
  initiativeId: string;
  taskId: string;
  topic: InitiativeSubscription['topic'];
  sourceTaskIds?: string[];
};

/** The initiative operations workspace control needs (see InitiativesService). */
export type ControlInitiatives = {
  list(): Promise<Initiative[]>;
  get(id: string): Promise<Initiative | null>;
  create(name: string): Promise<Initiative>;
  update(id: string, changes: { pushMessages?: boolean }): Promise<void>;
  subscriptions(initiativeId: string, taskId: string): Promise<InitiativeSubscription[]>;
  subscribe(input: SubscriptionChange): Promise<InitiativeSubscription[]>;
  unsubscribe(input: SubscriptionChange): Promise<InitiativeSubscription[]>;
  setTaskInitiative(taskIds: string[], initiativeId: string | null): Promise<void>;
  initiativeOfTask(taskId: string): Promise<Initiative | null>;
  post(input: {
    initiativeId: string;
    fromTaskId: string | null;
    toTaskId?: string | null;
    kind?: 'message' | 'event';
    body: string;
  }): Promise<InitiativeMessage>;
  messages(input: {
    initiativeId: string;
    forTaskId?: string;
    afterId?: string;
  }): Promise<InitiativeMessage[]>;
  waitForMessages(
    input: { initiativeId: string; forTaskId?: string; afterId?: string },
    timeoutMs: number
  ): Promise<InitiativeMessage[]>;
};

const MAX_WAIT_SECONDS = 300;

/** Who is calling: the conversation an Emjosh agent runs in, or an external client. */
export type ControlCaller = { conversationId: string | null };

export type WorkspaceControlDeps = {
  listProjects(): Promise<ControlProject[]>;
  /** Registers an existing local directory as a project. */
  addProject(input: { path: string; name: string }): Promise<ControlProject>;
  /** Clones a repository into `parentDirectory` (the repositories folder by default). */
  cloneProject(input: {
    repositoryUrl: string;
    name: string;
    parentDirectory?: string;
  }): Promise<ControlProject>;
  renameProject(projectId: string, name: string): Promise<void>;
  /** Removes the project from Emjosh, with its workspaces; repository files stay. */
  removeProject(projectId: string): Promise<void>;
  listWorkspaces(filter: {
    projectId?: string;
    includeArchived: boolean;
  }): Promise<Omit<ControlWorkspace, 'pullRequest'>[]>;
  pullRequestForBranch(projectId: string, branch: string): Promise<ControlPullRequest | null>;
  callerContext(conversationId: string): Promise<{ taskId: string; provider: string } | null>;
  archiveWorkspace(projectId: string, taskId: string): Promise<void>;
  renameWorkspace(projectId: string, taskId: string, name: string): Promise<void>;
  createWorkspace(
    input: CreateWorkspaceInput & { provider: string | undefined }
  ): Promise<{ id: string; name: string; branch: string | null }>;
  onArchived?(caller: ControlCaller, workspaces: { id: string; name: string }[]): void;
  initiatives?: ControlInitiatives;
};

function baseName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? path
  );
}

/** "git@github.com:org/repo.git" or "https://github.com/org/repo" → "repo". */
export function repositoryName(url: string): string {
  return (
    url
      .replace(/[\\/]+$/, '')
      .split(/[\\/:]/)
      .pop()
      ?.replace(/\.git$/, '') ?? ''
  );
}

/**
 * Workspace names are plain text; a branch-style slug ("investigate-jit-fund-reversal") becomes
 * words ("Investigate jit fund reversal"). Anything else is kept as written.
 */
export function humanizeSlug(name: string): string {
  const trimmed = name.trim();
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(trimmed)) return trimmed;
  const words = trimmed.replace(/[-_]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export class WorkspaceControlService {
  constructor(private readonly deps: WorkspaceControlDeps) {}

  listProjects(): Promise<ControlProject[]> {
    return this.deps.listProjects();
  }

  addProject(input: { path: string; name?: string }): Promise<ControlProject> {
    const path = input.path.trim();
    if (!path) throw new Error('A project needs a path.');
    return this.deps.addProject({ path, name: input.name?.trim() || baseName(path) });
  }

  cloneProject(input: {
    repositoryUrl: string;
    name?: string;
    parentDirectory?: string;
  }): Promise<ControlProject> {
    const repositoryUrl = input.repositoryUrl.trim();
    const name = input.name?.trim() || repositoryName(repositoryUrl);
    if (!repositoryUrl || !name)
      throw new Error('Pass a repository URL (and a name if it has none).');
    return this.deps.cloneProject({
      repositoryUrl,
      name,
      parentDirectory: input.parentDirectory?.trim() || undefined,
    });
  }

  async renameProject(input: { projectId: string; name: string }): Promise<void> {
    const name = input.name.trim();
    if (!name) throw new Error('A project needs a name.');
    await this.requireProject(input.projectId);
    await this.deps.renameProject(input.projectId, name);
  }

  /**
   * Removes a project from Emjosh. Refuses the caller's own project, and projects with open
   * workspaces unless `includeWorkspaces`: their worktrees (and any uncommitted work in them)
   * go with the project.
   */
  async removeProject(
    caller: ControlCaller,
    input: { projectId: string; includeWorkspaces?: boolean }
  ): Promise<{ removed: boolean; reason?: string }> {
    const project = await this.requireProject(input.projectId);
    const workspaces = (
      await this.deps.listWorkspaces({ projectId: project.id, includeArchived: false })
    ).filter((workspace) => workspace.projectId === project.id);
    const taskId = await this.callerTaskId(caller);
    if (taskId && workspaces.some((workspace) => workspace.id === taskId)) {
      return { removed: false, reason: "This conversation's own project can't be removed." };
    }
    if (workspaces.length > 0 && !input.includeWorkspaces) {
      return {
        removed: false,
        reason:
          `${project.name} has ${workspaces.length} open workspace(s), which would be removed ` +
          'with their worktrees. Pass includeWorkspaces only if the user confirmed that.',
      };
    }
    await this.deps.removeProject(project.id);
    return { removed: true };
  }

  private async requireProject(projectId: string): Promise<ControlProject> {
    const project = (await this.deps.listProjects()).find((p) => p.id === projectId);
    if (!project) throw new Error(`Project '${projectId}' was not found.`);
    return project;
  }

  async listWorkspaces(filter: {
    projectId?: string;
    includeArchived?: boolean;
  }): Promise<ControlWorkspace[]> {
    const rows = await this.deps.listWorkspaces({
      projectId: filter.projectId,
      includeArchived: filter.includeArchived ?? false,
    });
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        pullRequest: row.branch
          ? await this.deps.pullRequestForBranch(row.projectId, row.branch).catch(() => null)
          : null,
      }))
    );
  }

  async currentWorkspace(
    caller: ControlCaller
  ): Promise<(ControlWorkspace & { initiative: Initiative | null }) | null> {
    const taskId = await this.callerTaskId(caller);
    if (!taskId) return null;
    const all = await this.listWorkspaces({ includeArchived: true });
    const workspace = all.find((candidate) => candidate.id === taskId);
    if (!workspace) return null;
    const initiative = workspace.initiativeId
      ? ((await this.deps.initiatives?.get(workspace.initiativeId)) ?? null)
      : null;
    return { ...workspace, initiative };
  }

  /** Archives workspaces (reversible); never the caller's own. */
  async archiveWorkspaces(
    caller: ControlCaller,
    workspaceIds: string[]
  ): Promise<{ archived: string[]; skipped: { id: string; reason: string }[] }> {
    const context = caller.conversationId
      ? await this.deps.callerContext(caller.conversationId)
      : null;
    const byId = new Map(
      (await this.deps.listWorkspaces({ includeArchived: true })).map((w) => [w.id, w])
    );
    const archived: { id: string; name: string }[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of new Set(workspaceIds)) {
      const workspace = byId.get(id);
      if (!workspace) skipped.push({ id, reason: 'not found' });
      else if (id === context?.taskId) skipped.push({ id, reason: 'is the calling workspace' });
      else if (workspace.archived) skipped.push({ id, reason: 'already archived' });
      else {
        await this.deps.archiveWorkspace(workspace.projectId, id);
        archived.push({ id, name: workspace.name });
      }
    }
    if (archived.length > 0) this.deps.onArchived?.(caller, archived);
    return { archived: archived.map((workspace) => workspace.id), skipped };
  }

  /**
   * Names the caller's workspace after its work. Only replaces the generated placeholder
   * name, unless `override` (the user asked, or the work pivoted), so names stick.
   */
  async renameWorkspace(
    caller: ControlCaller,
    input: { name: string; override?: boolean }
  ): Promise<{ renamed: boolean; name: string; reason?: string }> {
    const taskId = await this.callerTaskId(caller);
    if (!taskId) throw new Error('Only an agent running in an Emjosh workspace can rename it.');
    const all = await this.deps.listWorkspaces({ includeArchived: true });
    const workspace = all.find((candidate) => candidate.id === taskId);
    if (!workspace) throw new Error('The calling workspace was not found.');
    if (!input.override && !isRandomTaskName(workspace.name)) {
      return {
        renamed: false,
        name: workspace.name,
        reason:
          'The workspace already has a name. Keep it for follow-ups; override only if the user ' +
          'asks or the work pivoted to something unrelated.',
      };
    }
    const siblings = all
      .filter((other) => other.projectId === workspace.projectId && other.id !== taskId)
      .map((other) => other.name);
    const name = ensureUniqueTaskDisplayName(humanizeSlug(input.name), siblings);
    if (!name) throw new Error('The name has no usable characters.');
    if (name !== workspace.name) await this.deps.renameWorkspace(workspace.projectId, taskId, name);
    return { renamed: true, name };
  }

  async createWorkspace(caller: ControlCaller, input: CreateWorkspaceInput) {
    const context = caller.conversationId
      ? await this.deps.callerContext(caller.conversationId)
      : null;
    const created = await this.deps.createWorkspace({
      ...input,
      provider: input.provider ?? context?.provider,
    });
    if (input.initiativeId) {
      const initiatives = this.requireInitiatives();
      await initiatives.setTaskInitiative([created.id], input.initiativeId);
      await initiatives.post({
        initiativeId: input.initiativeId,
        fromTaskId: context?.taskId ?? null,
        kind: 'event',
        body: `Workspace "${created.name}" was created${input.prompt ? ' and given a first task' : ''}.`,
      });
    }
    return created;
  }

  // ── Initiatives ────────────────────────────────────────────────────────────

  listInitiatives(): Promise<Initiative[]> {
    return this.requireInitiatives().list();
  }

  /** Creates an initiative holding the given workspaces, plus the caller's unless excluded. */
  async createInitiative(
    caller: ControlCaller,
    input: {
      name: string;
      workspaceIds?: string[];
      includeCallingWorkspace?: boolean;
      pushMessages?: boolean;
    }
  ): Promise<Initiative> {
    const initiatives = this.requireInitiatives();
    const initiative = await initiatives.create(input.name);
    // An agent creates an initiative to coordinate, which needs messages to reach the others'
    // chats; without delivery they only see messages they go looking for.
    await initiatives.update(initiative.id, { pushMessages: input.pushMessages ?? true });
    const taskId = await this.callerTaskId(caller);
    const members = [
      ...(input.includeCallingWorkspace !== false && taskId ? [taskId] : []),
      ...(input.workspaceIds ?? []),
    ];
    if (members.length > 0)
      await initiatives.setTaskInitiative([...new Set(members)], initiative.id);
    return (await initiatives.get(initiative.id)) ?? initiative;
  }

  async addToInitiative(input: { initiativeId: string; workspaceIds: string[] }) {
    await this.requireInitiatives().setTaskInitiative(input.workspaceIds, input.initiativeId);
    return this.requireInitiatives().get(input.initiativeId);
  }

  async removeFromInitiative(input: { workspaceIds: string[] }) {
    await this.requireInitiatives().setTaskInitiative(input.workspaceIds, null);
    return { removed: input.workspaceIds };
  }

  /** Posts to the caller's initiative (or the given one), to everyone or one workspace. */
  async postMessage(
    caller: ControlCaller,
    input: { text: string; toWorkspaceId?: string; initiativeId?: string }
  ): Promise<InitiativeMessage> {
    const { initiativeId, taskId } = await this.messagingScope(caller, input.initiativeId);
    return this.requireInitiatives().post({
      initiativeId,
      fromTaskId: taskId,
      toTaskId: input.toWorkspaceId ?? null,
      body: input.text,
    });
  }

  /**
   * Changes what the calling workspace listens to in its initiative: broadcasts ('messages') or
   * status events ('events'), from the given workspaces or, when none are given, from all.
   * Messages addressed to it always arrive.
   */
  async setSubscription(
    caller: ControlCaller,
    input: {
      subscribe: boolean;
      topic: InitiativeSubscription['topic'];
      fromWorkspaceIds?: string[];
      initiativeId?: string;
    }
  ): Promise<{ initiativeId: string; subscriptions: InitiativeSubscription[] }> {
    const { initiativeId, taskId } = await this.messagingScope(caller, input.initiativeId);
    if (!taskId) throw new Error('Only a workspace in the initiative can subscribe.');
    const change = {
      initiativeId,
      taskId,
      topic: input.topic,
      sourceTaskIds: input.fromWorkspaceIds,
    };
    const initiatives = this.requireInitiatives();
    const subscriptions = input.subscribe
      ? await initiatives.subscribe(change)
      : await initiatives.unsubscribe(change);
    return { initiativeId, subscriptions };
  }

  async listSubscriptions(
    caller: ControlCaller,
    input: { initiativeId?: string } = {}
  ): Promise<{ initiativeId: string; subscriptions: InitiativeSubscription[] }> {
    const { initiativeId, taskId } = await this.messagingScope(caller, input.initiativeId);
    if (!taskId) throw new Error('Only a workspace in the initiative has subscriptions.');
    return {
      initiativeId,
      subscriptions: await this.requireInitiatives().subscriptions(initiativeId, taskId),
    };
  }

  /** Turns delivery of the initiative's messages into its workspaces' chats on or off. */
  async setMessageDelivery(
    caller: ControlCaller,
    input: { enabled: boolean; initiativeId?: string }
  ): Promise<Initiative> {
    const { initiativeId } = await this.messagingScope(caller, input.initiativeId);
    const initiatives = this.requireInitiatives();
    await initiatives.update(initiativeId, { pushMessages: input.enabled });
    const initiative = await initiatives.get(initiativeId);
    if (!initiative) throw new Error(`Initiative '${initiativeId}' was not found.`);
    return initiative;
  }

  /** Messages for the caller: to it or everyone, not its own; only newer than `afterId`. */
  async readMessages(
    caller: ControlCaller,
    input: { initiativeId?: string; afterId?: string }
  ): Promise<InitiativeMessage[]> {
    const { initiativeId, taskId } = await this.messagingScope(caller, input.initiativeId);
    return this.requireInitiatives().messages({
      initiativeId,
      forTaskId: taskId ?? undefined,
      afterId: input.afterId,
    });
  }

  async waitForMessages(
    caller: ControlCaller,
    input: { initiativeId?: string; afterId?: string; timeoutSeconds?: number }
  ): Promise<InitiativeMessage[]> {
    const { initiativeId, taskId } = await this.messagingScope(caller, input.initiativeId);
    const seconds = Math.min(Math.max(input.timeoutSeconds ?? 60, 1), MAX_WAIT_SECONDS);
    return this.requireInitiatives().waitForMessages(
      { initiativeId, forTaskId: taskId ?? undefined, afterId: input.afterId },
      seconds * 1000
    );
  }

  private async callerTaskId(caller: ControlCaller): Promise<string | null> {
    if (!caller.conversationId) return null;
    return (await this.deps.callerContext(caller.conversationId))?.taskId ?? null;
  }

  private async messagingScope(caller: ControlCaller, initiativeId: string | undefined) {
    const taskId = await this.callerTaskId(caller);
    const resolved =
      initiativeId ??
      (taskId ? (await this.requireInitiatives().initiativeOfTask(taskId))?.id : undefined);
    if (!resolved) {
      throw new Error(
        taskId
          ? 'This workspace is not in an initiative; create or join one first.'
          : 'Pass an initiativeId.'
      );
    }
    return { initiativeId: resolved, taskId };
  }

  private requireInitiatives(): ControlInitiatives {
    if (!this.deps.initiatives) throw new Error('Initiatives are not available.');
    return this.deps.initiatives;
  }
}
