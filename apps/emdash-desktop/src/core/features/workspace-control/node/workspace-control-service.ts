import {
  isInitiativeEvent,
  type Initiative,
  type InitiativeDependency,
  type InitiativeMessage,
  type InitiativeMessageKind,
} from '@core/features/initiatives/api/contract';
import { dependencyOrder } from '@core/features/initiatives/api/dependency-order';
import { ensureUniqueTaskDisplayName, isRandomTaskName } from '@core/features/tasks/api/task-names';
import type { AppApi } from './app-api';

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
  /** The user or the lead marked the workspace done (its task status). */
  markedDone?: boolean;
  pullRequest: ControlPullRequest | null;
  /**
   * The order its initiative's workspaces should land in, from what they declared they depend
   * on. Absent unless the workspace is part of a dependency (it depends on one, or one depends
   * on it).
   */
  dependencyOrder?: WorkspaceDependencyOrder;
  /**
   * In an initiative: its latest status event and latest message, including the quiet ones
   * (status events, `fyi`) that aren't pushed into the lead's chat.
   */
  initiativeActivity?: ControlInitiativeActivity;
};

export type ControlInitiativeActivity = {
  lastEvent: Pick<InitiativeMessage, 'kind' | 'body' | 'createdAt'> | null;
  lastMessage: Pick<InitiativeMessage, 'kind' | 'toTaskId' | 'body' | 'createdAt'> | null;
};

export type WorkspaceDependencyOrder = {
  /** 1 lands first; workspaces that can land in parallel share a rank. Null on or behind a cycle. */
  rank: number | null;
  inCycle?: true;
  dependsOn: {
    workspaceId: string;
    name: string;
    /** Why it looks done (e.g. "PR #12 merged"): the dependency can probably be dropped. */
    looksDone: string | null;
  }[];
  /** The workspaces it depends on that don't look done yet. */
  waitingOn: string[];
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

export type WorkspaceTip = {
  projectId: string;
  /** The worktree, where git commands for it run. */
  path: string;
  sha: string;
  /** Commits were made on it after the workspace started (a fresh branch is its base commit). */
  workedOn: boolean;
  /**
   * Why HEAD isn't the branch's real tip right now (e.g. "mid-rebase", "detached HEAD"); such
   * a workspace isn't compared with others. Null when its branch is checked out normally.
   */
  unsettled?: string | null;
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
  setLead(initiativeId: string, taskId: string | null): Promise<void>;
  subscriptions(initiativeId: string, taskId: string): Promise<InitiativeSubscription[]>;
  subscribe(input: SubscriptionChange): Promise<InitiativeSubscription[]>;
  unsubscribe(input: SubscriptionChange): Promise<InitiativeSubscription[]>;
  setTaskInitiative(taskIds: string[], initiativeId: string | null): Promise<void>;
  /** Every live dependency; stale ones (archived or deleted tasks) are dropped on the way. */
  dependencies(): Promise<(InitiativeDependency & { initiativeId: string })[]>;
  setDependencies(taskId: string, dependsOnTaskIds: string[]): Promise<void>;
  removeDependency(dependency: { taskId: string; dependsOnTaskId: string }): Promise<void>;
  setDependencyDoneNotice(
    dependency: { taskId: string; dependsOnTaskId: string },
    doneNotice: string | null
  ): Promise<void>;
  initiativeOfTask(taskId: string): Promise<Initiative | null>;
  post(input: {
    initiativeId: string;
    fromTaskId: string | null;
    toTaskId?: string | null;
    kind?: InitiativeMessage['kind'];
    body: string;
  }): Promise<InitiativeMessage>;
  /** Each sending task's latest status event and message (see InitiativesService.activity). */
  activity?(initiativeId: string): Promise<Map<string, ControlInitiativeActivity>>;
  messages(input: {
    initiativeId: string;
    forTaskId?: string;
    afterId?: string;
    limit?: number;
  }): Promise<InitiativeMessage[]>;
  /** Moves `fromTaskId`'s dependencies and dependents onto `intoTaskId`; reports skipped ones. */
  moveDependencies(fromTaskId: string, intoTaskId: string): Promise<{ skipped: string[] }>;
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
  /** `options`: the conversation's own session settings, such as its permission mode. */
  callerContext(conversationId: string): Promise<{
    taskId: string;
    provider: string;
    options?: Record<string, string | boolean>;
  } | null>;
  archiveWorkspace(projectId: string, taskId: string): Promise<void>;
  restoreWorkspace(projectId: string, taskId: string): Promise<void>;
  renameWorkspace(projectId: string, taskId: string, name: string): Promise<void>;
  /** Sets or clears the workspace's done mark (its task status). */
  setWorkspaceDone?(taskId: string, done: boolean): Promise<void>;
  /** The base branch the workspace's branch was merged into since it started; else null. */
  branchMergedInto?(workspaceId: string): Promise<string | null>;
  /** The commit a local worktree workspace is on; null for other workspaces. */
  workspaceTip?(workspaceId: string): Promise<WorkspaceTip | null>;
  /** Whether commit `ancestor` is in the history of `descendant`, in the repository at `cwd`. */
  isAncestor?(cwd: string, ancestor: string, descendant: string): Promise<boolean>;
  /** The workspace's uncommitted changes (`git status --porcelain` lines). */
  uncommittedChanges?(workspaceId: string): Promise<string[]>;
  /** The workspace's commits since its base branch, newest first, one line each. */
  commitLog?(workspaceId: string): Promise<string[]>;
  /** Sends text into the workspace's agent chat; false when it has no chat to send to. */
  sendToWorkspaceChat?(workspaceId: string, text: string): Promise<boolean>;
  /** How long a fold waits for the folded workspace's agent to hand off (default 10 minutes). */
  handoffTimeoutMs?: number;
  createWorkspace(
    input: CreateWorkspaceInput & {
      provider: string | undefined;
      /** Publish the branch to the remote (default true). */
      pushBranch?: boolean;
      /** Session settings for the first conversation, over the provider's saved preferences. */
      options?: Record<string, string | boolean>;
    }
  ): Promise<{ id: string; name: string; branch: string | null }>;
  onArchived?(caller: ControlCaller, workspaces: { id: string; name: string }[]): void;
  initiatives?: ControlInitiatives;
  /** The rest of the app, for whatever the dedicated operations don't cover. */
  appApi?: AppApi;
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
    const pullRequests = new Map<string, Promise<ControlPullRequest | null>>();
    const activity = await this.initiativeActivity(rows);
    const workspaces = await Promise.all(
      rows.map(async (row) => {
        const latest = row.initiativeId ? activity.get(row.initiativeId)?.get(row.id) : undefined;
        return {
          ...row,
          pullRequest: await this.pullRequestOf(row, pullRequests),
          ...(latest && { initiativeActivity: latest }),
        };
      })
    );
    const orders = await this.dependencyOrders(pullRequests).catch(() => new Map());
    return workspaces.map((workspace) => {
      const order = orders.get(workspace.id);
      return order ? { ...workspace, dependencyOrder: order } : workspace;
    });
  }

  private pullRequestOf(
    row: { id: string; projectId: string; branch: string | null },
    cache: Map<string, Promise<ControlPullRequest | null>>
  ): Promise<ControlPullRequest | null> {
    let pending = cache.get(row.id);
    if (!pending) {
      pending = row.branch
        ? this.deps.pullRequestForBranch(row.projectId, row.branch).catch(() => null)
        : Promise.resolve(null);
      cache.set(row.id, pending);
    }
    return pending;
  }

  /**
   * Why a workspace looks done, so depending on it no longer makes sense: marked done, its PR
   * merged, or its branch merged into the base branch. Null when it doesn't.
   */
  private async looksDone(
    row: Omit<ControlWorkspace, 'pullRequest'>,
    pullRequests: Map<string, Promise<ControlPullRequest | null>>
  ): Promise<string | null> {
    if (row.markedDone) return 'marked done';
    const pr = await this.pullRequestOf(row, pullRequests);
    if (pr?.state === 'merged') return pr.number ? `PR #${pr.number} merged` : 'its PR merged';
    const base = await this.deps.branchMergedInto?.(row.id).catch(() => null);
    return base ? `branch merged into ${base}` : null;
  }

  private checking: Promise<Map<string, WorkspaceDependencyOrder>> | null = null;

  /**
   * The dependency order of every workspace in an initiative with dependencies, keyed by
   * workspace id. Tells each initiative's lead (once per dependency) when a workspace depends on
   * one that looks done, so the lead can drop the dependency; it is not dropped automatically.
   */
  checkDependencies(): Promise<Map<string, WorkspaceDependencyOrder>> {
    return this.dependencyOrders(new Map());
  }

  private dependencyOrders(
    pullRequests: Map<string, Promise<ControlPullRequest | null>>
  ): Promise<Map<string, WorkspaceDependencyOrder>> {
    // One check at a time, so a dependency that looks done is announced once.
    this.checking ??= this.computeDependencyOrders(pullRequests).finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async computeDependencyOrders(
    pullRequests: Map<string, Promise<ControlPullRequest | null>>
  ): Promise<Map<string, WorkspaceDependencyOrder>> {
    const result = new Map<string, WorkspaceDependencyOrder>();
    const initiatives = this.deps.initiatives;
    if (!initiatives) return result;
    const active = await this.deps.listWorkspaces({ includeArchived: false });
    const byId = new Map(active.map((row) => [row.id, row]));
    const contains = this.containmentCheck();
    await this.announceContainedWorkspaces(active, contains);

    const declared = await initiatives.dependencies();
    if (declared.length === 0) return result;
    const dependencies = await this.dropContainedDependencies(declared, byId, contains);
    if (dependencies.length === 0) return result;
    const doneReasons = new Map<string, string | null>();
    for (const id of new Set(dependencies.map((d) => d.dependsOnTaskId))) {
      const row = byId.get(id);
      doneReasons.set(id, row ? await this.looksDone(row, pullRequests) : null);
    }

    for (const initiativeId of new Set(dependencies.map((d) => d.initiativeId))) {
      const edges = dependencies.filter((d) => d.initiativeId === initiativeId);
      const members = active.filter((row) => row.initiativeId === initiativeId);
      const order = dependencyOrder(
        members.map((row) => row.id),
        edges
      );
      const linked = new Set(edges.flatMap((edge) => [edge.taskId, edge.dependsOnTaskId]));
      // Only workspaces that are part of a dependency get an order; the rest are unaffected.
      for (const member of members.filter((row) => linked.has(row.id))) {
        const dependsOn = edges
          .filter((edge) => edge.taskId === member.id)
          .map((edge) => ({
            workspaceId: edge.dependsOnTaskId,
            name: byId.get(edge.dependsOnTaskId)?.name ?? edge.dependsOnTaskId,
            looksDone: doneReasons.get(edge.dependsOnTaskId) ?? null,
          }));
        result.set(member.id, {
          rank: order.ranks.get(member.id) ?? null,
          ...(order.inCycle.has(member.id) ? { inCycle: true as const } : {}),
          dependsOn,
          waitingOn: dependsOn.filter((d) => !d.looksDone).map((d) => d.workspaceId),
        });
      }
      await this.announceDoneDependencies(initiativeId, edges, byId, doneReasons);
    }
    return result;
  }

  /**
   * Drops dependencies whose workspace's branch already contains the dependency's work (it
   * rebased onto it or merged it in): waiting on it means nothing any more. Unlike "looks done",
   * this is unambiguous, so the lead is only told. Returns the remaining dependencies.
   */
  private async dropContainedDependencies<
    T extends InitiativeDependency & { initiativeId: string },
  >(
    dependencies: T[],
    byId: Map<string, { name: string }>,
    contains: (holderId: string, heldId: string) => Promise<boolean>
  ): Promise<T[]> {
    const initiatives = this.requireInitiatives();
    const kept: T[] = [];
    for (const edge of dependencies) {
      if (!(await contains(edge.taskId, edge.dependsOnTaskId))) {
        kept.push(edge);
        continue;
      }
      await initiatives.removeDependency(edge);
      const name = (id: string) => byId.get(id)?.name ?? id;
      const leadTaskId = (await initiatives.get(edge.initiativeId))?.leadTaskId ?? null;
      await initiatives.post({
        initiativeId: edge.initiativeId,
        fromTaskId: null,
        toTaskId: leadTaskId,
        kind: 'event',
        body:
          `Dropped the dependency of "${name(edge.taskId)}" on "${name(edge.dependsOnTaskId)}": ` +
          `its branch already contains "${name(edge.dependsOnTaskId)}"'s work.`,
      });
    }
    return kept;
  }

  /**
   * Whether one workspace's branch contains another's work (it rebased onto it or merged it
   * in), for one check: each workspace's tip is read once. A branch without work of its own is
   * contained in every later one, so it never counts.
   */
  private containmentCheck(): (holderId: string, heldId: string) => Promise<boolean> {
    const { workspaceTip, isAncestor } = this.deps;
    if (!workspaceTip || !isAncestor) return async () => false;
    const tips = new Map<string, Promise<WorkspaceTip | null>>();
    const tipOf = (id: string) => {
      let tip = tips.get(id);
      if (!tip) {
        tip = workspaceTip(id).catch(() => null);
        tips.set(id, tip);
      }
      return tip;
    };
    return async (holderId, heldId) => {
      const [holder, held] = await Promise.all([tipOf(holderId), tipOf(heldId)]);
      if (!holder || !held?.workedOn || holder.projectId !== held.projectId) return false;
      // Mid-rebase (or detached) HEAD is wherever git happens to be, not the branch's tip.
      if (holder.unsettled || held.unsettled) return false;
      return isAncestor(holder.path, held.sha, holder.sha).catch(() => false);
    };
  }

  /**
   * Tells each initiative's lead, once, about workspaces whose branch is contained in another
   * active workspace's of the same project, so it can fold them together (merge_workspaces).
   * A branch already merged into its base is skipped: every branch rebased on that base contains
   * it, and it looks done to the dependency check instead.
   */
  private async announceContainedWorkspaces(
    active: Omit<ControlWorkspace, 'pullRequest'>[],
    contains: (holderId: string, heldId: string) => Promise<boolean>
  ): Promise<void> {
    const initiatives = this.requireInitiatives();
    const groups = new Map<string, Omit<ControlWorkspace, 'pullRequest'>[]>();
    for (const row of active) {
      if (!row.initiativeId) continue;
      const key = `${row.initiativeId}\0${row.projectId}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      const initiativeId = rows[0]!.initiativeId!;
      const initiative = await initiatives.get(initiativeId);
      const members = rows.filter(
        (row) => row.id !== initiative?.leadTaskId && !this.folds.has(row.id)
      );
      const found: { from: (typeof rows)[number]; into: (typeof rows)[number] }[] = [];
      for (const from of members) {
        if (await this.mergedIntoBase(from.id)) continue;
        for (const into of members) {
          if (from.id === into.id || !(await contains(into.id, from.id))) continue;
          // Two branches on the same commit contain each other: report the pair once.
          if (from.id > into.id && (await contains(from.id, into.id))) continue;
          found.push({ from, into });
        }
      }
      if (found.length === 0) continue;
      const posted = new Set(
        (await initiatives.messages({ initiativeId, limit: 100_000 })).map((m) => m.body)
      );
      for (const { from, into } of found) {
        const body = containmentNotice(from, into);
        if (posted.has(body)) continue;
        await initiatives.post({
          initiativeId,
          fromTaskId: null,
          toTaskId: initiative?.leadTaskId ?? null,
          kind: 'attention',
          body,
        });
      }
    }
  }

  private async mergedIntoBase(workspaceId: string): Promise<boolean> {
    const base = await this.deps.branchMergedInto?.(workspaceId).catch(() => null);
    return !!base;
  }

  // ── Folding workspaces ─────────────────────────────────────────────────────

  /** Folds in progress, by the folded workspace: resolves with its agent's handoff. */
  private readonly folds = new Map<
    string,
    { intoId: string; handoff: (text: string) => void; done: Promise<void> }
  >();

  /**
   * Folds workspace `from` into `into` (whose branch already contains all of `from`'s work):
   * asks `from`'s agent for a handoff summary (falling back to its commit log and feed messages
   * if it can't answer in time), delivers it into `into`'s chat, moves `from`'s dependencies
   * and dependents onto `into`, and archives `from`. Refuses up front if `from` has uncommitted
   * changes or commits `into` lacks; the rest runs in the background and reports to the
   * initiative's lead. Only the lead (or a client outside Emjosh) may fold.
   */
  async mergeWorkspaces(
    caller: ControlCaller,
    input: { from: string; into: string }
  ): Promise<{ started: true; from: string; into: string; handoff: string }> {
    const initiatives = this.requireInitiatives();
    if (input.from === input.into) throw new Error('A workspace cannot be folded into itself.');
    if (this.folds.has(input.from)) throw new Error('That workspace is already being folded.');
    const { from, into, initiativeId } = await this.foldPair(caller, input);
    await this.assertFoldable(from, into);

    let handoff: (text: string) => void = () => {};
    const handedOff = new Promise<string>((resolve) => {
      handoff = resolve;
    });
    const fold = { intoId: into.id, handoff, done: Promise.resolve() };
    this.folds.set(from.id, fold);
    const timeoutMs = this.deps.handoffTimeoutMs ?? 10 * 60_000;
    fold.done = this.runFold({ from, into, initiativeId, handedOff, timeoutMs })
      .catch(async (error: unknown) => {
        await initiatives.post({
          initiativeId,
          fromTaskId: null,
          toTaskId: (await initiatives.get(initiativeId))?.leadTaskId ?? null,
          kind: 'attention',
          body: `Folding "${from.name}" into "${into.name}" stopped: ${errorMessage(error)}`,
        });
      })
      .finally(() => this.folds.delete(from.id));
    return {
      started: true,
      from: from.id,
      into: into.id,
      handoff:
        `Asked "${from.name}"'s agent for a handoff summary (waiting up to ` +
        `${Math.round(timeoutMs / 60_000)} min, then falling back to its commit log and feed ` +
        'messages). You get an event when the fold is done.',
    };
  }

  /** Waits for a fold in progress to finish (for tests and callers that need it settled). */
  async waitForFold(fromId: string): Promise<void> {
    await this.folds.get(fromId)?.done;
  }

  /** The folded workspace's agent hands over its context (see mergeWorkspaces). */
  async submitHandoff(caller: ControlCaller, input: { text: string }): Promise<{ ok: true }> {
    const taskId = await this.callerTaskId(caller);
    const fold = taskId ? this.folds.get(taskId) : undefined;
    if (!fold) throw new Error('No fold is waiting for a handoff from this workspace.');
    const text = input.text.trim();
    if (!text) throw new Error('The handoff needs text.');
    fold.handoff(text);
    return { ok: true };
  }

  private async foldPair(caller: ControlCaller, input: { from: string; into: string }) {
    const initiatives = this.requireInitiatives();
    const active = await this.deps.listWorkspaces({ includeArchived: false });
    const from = active.find((row) => row.id === input.from);
    const into = active.find((row) => row.id === input.into);
    if (!from || !into) {
      throw new Error(`Workspace '${from ? input.into : input.from}' is not an active workspace.`);
    }
    if (!from.initiativeId || from.initiativeId !== into.initiativeId) {
      throw new Error('Both workspaces must be in the same initiative.');
    }
    if (from.projectId !== into.projectId) {
      throw new Error('Both workspaces must be in the same project (repository).');
    }
    const initiative = await initiatives.get(from.initiativeId);
    const taskId = await this.callerTaskId(caller);
    if (taskId && taskId !== initiative?.leadTaskId) {
      throw new Error(`Only the lead of initiative "${initiative?.name}" folds its workspaces.`);
    }
    if (from.id === initiative?.leadTaskId) throw new Error("The lead can't be folded away.");
    return { from, into, initiativeId: from.initiativeId };
  }

  /** Throws unless all of `from`'s work is committed and contained in `into`'s branch. */
  private async assertFoldable(
    from: { id: string; name: string },
    into: { id: string; name: string }
  ): Promise<void> {
    const { workspaceTip, isAncestor, uncommittedChanges } = this.deps;
    if (!workspaceTip || !isAncestor || !uncommittedChanges) {
      throw new Error('Folding workspaces is not available.');
    }
    const [fromTip, intoTip] = await Promise.all([workspaceTip(from.id), workspaceTip(into.id)]);
    if (!fromTip || !intoTip) {
      throw new Error('Both workspaces need a local worktree to compare their branches.');
    }
    for (const [workspace, tip] of [
      [from, fromTip],
      [into, intoTip],
    ] as const) {
      if (tip.unsettled) {
        throw new Error(
          `"${workspace.name}" is ${tip.unsettled}; wait until its branch is checked out normally.`
        );
      }
    }
    const changes = await uncommittedChanges(from.id);
    if (changes.length > 0) {
      throw new Error(
        `"${from.name}" has ${changes.length} uncommitted change(s); commit or discard them ` +
          `first:\n${changes.slice(0, 10).join('\n')}`
      );
    }
    if (!(await isAncestor(intoTip.path, fromTip.sha, intoTip.sha))) {
      throw new Error(
        `"${from.name}" has commits that "${into.name}"'s branch doesn't contain; merge or ` +
          'rebase them in first.'
      );
    }
  }

  private async runFold(input: {
    from: Omit<ControlWorkspace, 'pullRequest'>;
    into: Omit<ControlWorkspace, 'pullRequest'>;
    initiativeId: string;
    handedOff: Promise<string>;
    timeoutMs: number;
  }): Promise<void> {
    const { from, into, initiativeId } = input;
    const initiatives = this.requireInitiatives();
    const asked =
      (await this.deps
        .sendToWorkspaceChat?.(from.id, handoffRequest(from.name, into.name))
        .catch(() => false)) ?? false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fromAgent = asked
      ? await Promise.race([
          input.handedOff,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), input.timeoutMs);
          }),
        ])
      : null;
    clearTimeout(timer);
    const summary = fromAgent ?? (await this.fallbackHandoff(from, initiativeId));
    const source = fromAgent
      ? 'written by its agent'
      : asked
        ? "built from its commits and feed messages; its agent didn't answer in time"
        : 'built from its commits and feed messages; it has no agent chat to ask';

    // The agent may have changed things while answering.
    await this.assertFoldable(from, into);
    const delivered =
      (await this.deps
        .sendToWorkspaceChat?.(
          into.id,
          `[Handoff from workspace "${from.name}", folded into this one by the initiative lead. ` +
            `Its branch is already part of yours; this is its context (${source}). Read it ` +
            `and carry on with your work.]\n\n${summary}`
        )
        .catch(() => false)) ?? false;
    const { skipped } = await initiatives.moveDependencies(from.id, into.id);
    await this.deps.archiveWorkspace(from.projectId, from.id);
    await initiatives.post({
      initiativeId,
      fromTaskId: null,
      toTaskId: (await initiatives.get(initiativeId))?.leadTaskId ?? null,
      kind: 'event',
      body:
        `Folded "${from.name}" into "${into.name}" and archived "${from.name}". Handoff summary ` +
        `(${source}) ${delivered ? `delivered to "${into.name}"` : `could not be delivered to "${into.name}"'s chat`}.` +
        (skipped.length > 0
          ? ` Dependencies not moved (would form a cycle): ${skipped.join('; ')}.`
          : '') +
        `\n\n${summary}`,
    });
  }

  private async fallbackHandoff(
    from: { id: string; name: string },
    initiativeId: string
  ): Promise<string> {
    const commits = (await this.deps.commitLog?.(from.id).catch(() => [])) ?? [];
    const posts = (await this.requireInitiatives().messages({ initiativeId, limit: 100_000 }))
      .filter((message) => message.fromTaskId === from.id && !isInitiativeEvent(message.kind))
      .slice(-5);
    return [
      `Commits on "${from.name}" (newest first):`,
      ...(commits.length > 0 ? commits.slice(0, 30).map((line) => `- ${line}`) : ['- none found']),
      '',
      `Its last messages to the initiative:`,
      ...(posts.length > 0 ? posts.map((m) => `- ${m.body.replace(/\s+/g, ' ')}`) : ['- none']),
    ].join('\n');
  }

  private async announceDoneDependencies(
    initiativeId: string,
    edges: InitiativeDependency[],
    byId: Map<string, { name: string }>,
    doneReasons: Map<string, string | null>
  ): Promise<void> {
    const initiatives = this.requireInitiatives();
    let leadTaskId: string | null | undefined;
    for (const edge of edges) {
      const reason = doneReasons.get(edge.dependsOnTaskId) ?? null;
      if (reason === edge.doneNotice) continue;
      await initiatives.setDependencyDoneNotice(edge, reason);
      // Only newly done dependencies are announced; one that stopped looking done is re-armed.
      if (!reason || edge.doneNotice) continue;
      leadTaskId ??= (await initiatives.get(initiativeId))?.leadTaskId ?? null;
      const name = (id: string) => byId.get(id)?.name ?? id;
      await initiatives.post({
        initiativeId,
        fromTaskId: null,
        toTaskId: leadTaskId,
        kind: 'attention',
        body:
          `Workspace "${name(edge.taskId)}" depends on "${name(edge.dependsOnTaskId)}", which ` +
          `looks done (${reason}). If so, drop the dependency with set_workspace_dependencies.`,
      });
    }
  }

  /**
   * Replaces what a workspace depends on (workspaces of its initiative that should land first);
   * an empty list removes them. Only the initiative's lead (or a client outside Emjosh) may.
   */
  async setWorkspaceDependencies(
    caller: ControlCaller,
    input: { workspaceId: string; dependsOn: string[] }
  ): Promise<ControlWorkspace> {
    const initiatives = this.requireInitiatives();
    const initiative = await initiatives.initiativeOfTask(input.workspaceId);
    if (!initiative) throw new Error(`Workspace '${input.workspaceId}' is not in an initiative.`);
    const taskId = await this.callerTaskId(caller);
    if (taskId && taskId !== initiative.leadTaskId) {
      throw new Error(`Only the lead of initiative "${initiative.name}" sets its dependencies.`);
    }
    await initiatives.setDependencies(input.workspaceId, input.dependsOn);
    return this.requireWorkspace(input.workspaceId);
  }

  /**
   * Marks a workspace done (or not): workspaces depending on it are flagged and the lead told.
   * The initiative's lead may mark any of its workspaces; a workspace may mark itself.
   */
  async markWorkspaceDone(
    caller: ControlCaller,
    input: { workspaceId: string; done: boolean }
  ): Promise<ControlWorkspace> {
    if (!this.deps.setWorkspaceDone) throw new Error('Marking workspaces done is not available.');
    const taskId = await this.callerTaskId(caller);
    if (taskId && taskId !== input.workspaceId) {
      const initiative = await this.deps.initiatives?.initiativeOfTask(input.workspaceId);
      if (!initiative || initiative.leadTaskId !== taskId) {
        throw new Error('Only the workspace itself or its initiative lead can mark it done.');
      }
    }
    await this.deps.setWorkspaceDone(input.workspaceId, input.done);
    return this.requireWorkspace(input.workspaceId);
  }

  private async requireWorkspace(workspaceId: string): Promise<ControlWorkspace> {
    const workspace = (await this.listWorkspaces({ includeArchived: true })).find(
      (candidate) => candidate.id === workspaceId
    );
    if (!workspace) throw new Error(`Workspace '${workspaceId}' was not found.`);
    return workspace;
  }

  private async initiativeActivity(
    rows: { initiativeId: string | null }[]
  ): Promise<Map<string, Map<string, ControlInitiativeActivity>>> {
    const activity = this.deps.initiatives?.activity?.bind(this.deps.initiatives);
    const ids = [...new Set(rows.flatMap((row) => (row.initiativeId ? [row.initiativeId] : [])))];
    if (!activity || ids.length === 0) return new Map();
    return new Map(await Promise.all(ids.map(async (id) => [id, await activity(id)] as const)));
  }

  async currentWorkspace(
    caller: ControlCaller
  ): Promise<(ControlWorkspace & { initiative: Initiative | null; isLead: boolean }) | null> {
    const taskId = await this.callerTaskId(caller);
    if (!taskId) return null;
    const all = await this.listWorkspaces({ includeArchived: true });
    const workspace = all.find((candidate) => candidate.id === taskId);
    if (!workspace) return null;
    const initiative = workspace.initiativeId
      ? ((await this.deps.initiatives?.get(workspace.initiativeId)) ?? null)
      : null;
    return { ...workspace, initiative, isLead: initiative?.leadTaskId === taskId };
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

  /** Brings archived workspaces back. */
  async unarchiveWorkspaces(
    workspaceIds: string[]
  ): Promise<{ unarchived: string[]; skipped: { id: string; reason: string }[] }> {
    const byId = new Map(
      (await this.deps.listWorkspaces({ includeArchived: true })).map((w) => [w.id, w])
    );
    const unarchived: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of new Set(workspaceIds)) {
      const workspace = byId.get(id);
      if (!workspace) skipped.push({ id, reason: 'not found' });
      else if (!workspace.archived) skipped.push({ id, reason: 'not archived' });
      else {
        await this.deps.restoreWorkspace(workspace.projectId, id);
        unarchived.push(id);
      }
    }
    return { unarchived, skipped };
  }

  appApi(): AppApi {
    if (!this.deps.appApi) throw new Error('The app API is not available.');
    return this.deps.appApi;
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

  async createWorkspace(
    caller: ControlCaller,
    input: CreateWorkspaceInput & { pushBranch?: boolean }
  ) {
    const context = caller.conversationId
      ? await this.deps.callerContext(caller.conversationId)
      : null;
    const provider = input.provider ?? context?.provider;
    const created = await this.deps.createWorkspace({
      ...input,
      provider,
      // The new agent runs like the caller's (the same permission mode, above all), as far as
      // they run the same agent.
      ...(context?.options && provider === context.provider ? { options: context.options } : {}),
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

  /**
   * Creates an initiative holding the given workspaces, plus the caller's unless excluded, and
   * its lead: the given workspace, or else a new workspace started with the goal, whose only
   * job is orchestrating the others.
   */
  async createInitiative(
    caller: ControlCaller,
    input: {
      name: string;
      goal?: string;
      leadWorkspaceId?: string;
      leadProjectId?: string;
      workspaceIds?: string[];
      includeCallingWorkspace?: boolean;
      pushMessages?: boolean;
    }
  ): Promise<{ initiative: Initiative; lead: { id: string; name: string; created: boolean } }> {
    const initiatives = this.requireInitiatives();
    const context = caller.conversationId
      ? await this.deps.callerContext(caller.conversationId)
      : null;
    const taskId = context?.taskId ?? null;
    const all = await this.deps.listWorkspaces({ includeArchived: false });
    const callerWorkspace = taskId ? all.find((workspace) => workspace.id === taskId) : undefined;
    const existingLead = input.leadWorkspaceId
      ? all.find((workspace) => workspace.id === input.leadWorkspaceId)
      : undefined;
    if (input.leadWorkspaceId && !existingLead) {
      throw new Error(`Workspace '${input.leadWorkspaceId}' was not found.`);
    }
    const leadProjectId = input.leadProjectId ?? callerWorkspace?.projectId;
    if (!existingLead && !leadProjectId) {
      throw new Error('Pass leadProjectId (the project to start the lead workspace in).');
    }
    if (!existingLead && !input.goal?.trim()) {
      throw new Error("Pass the goal: it is the new lead workspace's first prompt.");
    }

    const initiative = await initiatives.create(input.name);
    // An agent creates an initiative to coordinate, which needs messages to reach the others'
    // chats; without delivery they only see messages they go looking for.
    await initiatives.update(initiative.id, { pushMessages: input.pushMessages ?? true });
    const members = [
      ...(input.includeCallingWorkspace !== false && taskId ? [taskId] : []),
      ...(input.workspaceIds ?? []),
    ];
    if (members.length > 0)
      await initiatives.setTaskInitiative([...new Set(members)], initiative.id);

    const lead = existingLead
      ? { id: existingLead.id, name: existingLead.name, created: false }
      : {
          ...(await this.createWorkspace(caller, {
            projectId: leadProjectId!,
            name: `${initiative.name} lead`,
            prompt: leadPrompt({
              initiative,
              goal: input.goal!.trim(),
              requester:
                callerWorkspace && members.includes(callerWorkspace.id)
                  ? { id: callerWorkspace.id, name: callerWorkspace.name }
                  : null,
            }),
            initiativeId: initiative.id,
            // The lead doesn't change code, so its branch has nothing to publish.
            pushBranch: false,
          })),
          created: true,
        };
    await initiatives.setLead(initiative.id, lead.id);
    return {
      initiative: (await initiatives.get(initiative.id)) ?? initiative,
      lead: { id: lead.id, name: lead.name, created: lead.created },
    };
  }

  /** Makes a workspace of the caller's initiative (or the given one) its lead. */
  async setInitiativeLead(
    caller: ControlCaller,
    input: { workspaceId: string; initiativeId?: string }
  ): Promise<Initiative> {
    const { initiativeId } = await this.messagingScope(caller, input.initiativeId);
    const initiatives = this.requireInitiatives();
    await initiatives.setLead(initiativeId, input.workspaceId);
    const initiative = await initiatives.get(initiativeId);
    if (!initiative) throw new Error(`Initiative '${initiativeId}' was not found.`);
    return initiative;
  }

  async addToInitiative(input: { initiativeId: string; workspaceIds: string[] }) {
    await this.requireInitiatives().setTaskInitiative(input.workspaceIds, input.initiativeId);
    return this.requireInitiatives().get(input.initiativeId);
  }

  async removeFromInitiative(input: { workspaceIds: string[] }) {
    await this.requireInitiatives().setTaskInitiative(input.workspaceIds, null);
    return { removed: input.workspaceIds };
  }

  /**
   * Posts to the caller's initiative (or the given one), to everyone or one workspace. `kind`
   * decides whether it wakes the recipients (see messageWakesTask); without one, a message to the
   * lead wakes it and a broadcast stays quiet.
   */
  async postMessage(
    caller: ControlCaller,
    input: {
      text: string;
      toWorkspaceId?: string;
      initiativeId?: string;
      kind?: InitiativeMessageKind;
    }
  ): Promise<InitiativeMessage> {
    const { initiativeId, taskId } = await this.messagingScope(caller, input.initiativeId);
    return this.requireInitiatives().post({
      initiativeId,
      fromTaskId: taskId,
      toTaskId: input.toWorkspaceId ?? null,
      kind: input.kind,
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
  ): Promise<{
    initiativeId: string;
    leadWorkspaceId: string | null;
    builtIn: string;
    subscriptions: InitiativeSubscription[];
  }> {
    const { initiativeId, taskId } = await this.messagingScope(caller, input.initiativeId);
    if (!taskId) throw new Error('Only a workspace in the initiative has subscriptions.');
    const initiatives = this.requireInitiatives();
    const leadWorkspaceId = (await initiatives.get(initiativeId))?.leadTaskId ?? null;
    return {
      initiativeId,
      leadWorkspaceId,
      builtIn:
        leadWorkspaceId === taskId
          ? 'You lead this initiative: you receive every message and status event in it.'
          : "Messages addressed to you, the user's posts" +
            (leadWorkspaceId ? ", and the lead's broadcasts." : '.'),
      subscriptions: await initiatives.subscriptions(initiativeId, taskId),
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

/** First prompt of a workspace started to lead an initiative. */
export function leadPrompt(input: {
  initiative: Pick<Initiative, 'id' | 'name'>;
  goal: string;
  requester: { id: string; name: string } | null;
}): string {
  return [
    `You lead the Emjosh initiative "${input.initiative.name}" (id ${input.initiative.id}). ` +
      'You are its orchestrator, not a worker: plan the work, start a workspace for each part ' +
      'with create_workspace (in whichever project the part belongs, this one included), ' +
      'coordinate them through the initiative, and keep the user informed. You receive every ' +
      'message and status event in the initiative, and every member receives your broadcasts.',
    `Goal:\n${input.goal}`,
    ...(input.requester
      ? [
          `Workspace "${input.requester.name}" (id ${input.requester.id}) asked for this ` +
            'initiative and is a member. It may already be doing part of the work: check with ' +
            'it before assigning that part elsewhere.',
        ]
      : []),
    'Stay responsive. What needs you (members done, blocked or needing a decision, the ' +
      "user's posts) is delivered into this chat in batches once your current turn ends, so " +
      'keep turns short; status events and fyi messages wait in read_messages. Do not do slow or non-trivial work yourself ' +
      '(code changes, builds, test runs, long investigations); send it to a workspace. Do not ' +
      'change code in this workspace.',
  ].join('\n\n');
}

/** The lead's notice that one workspace's branch is contained in another's. */
export function containmentNotice(
  from: { id: string; name: string },
  into: { id: string; name: string }
): string {
  return (
    `"${from.name}"'s branch is contained in "${into.name}"'s; fold "${from.name}" into ` +
    `"${into.name}"? (merge_workspaces from ${from.id} into ${into.id})`
  );
}

/** What the folded workspace's agent is asked for. */
export function handoffRequest(fromName: string, intoName: string): string {
  return (
    `[From Emjosh: the initiative lead is folding this workspace ("${fromName}") into ` +
    `"${intoName}", whose branch already contains all of this branch's work. This workspace ` +
    'will be archived.] Hand over your context: call the handoff_summary tool once with a ' +
    'concise summary for the agent taking over: what changed and why, decisions made (and ' +
    "alternatives rejected), and open items or follow-ups. Don't change, commit or push " +
    'anything now.'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
