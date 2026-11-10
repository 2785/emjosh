import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import type { Logger } from '@emdash/shared/logger';
import type { ContractClient } from '@emdash/wire/rpc';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry/conversation-registry';
import {
  sendAcpConversationPrompt,
  startAcpConversationSession,
} from '@core/features/conversations/node/wire-controller';
import type { InitiativeMessage } from '@core/features/initiatives/api/contract';
import { createProjectOperations } from '@core/features/projects/node/controller';
import { createProjectFromRemote } from '@core/features/projects/node/operations/create-project-from-remote';
import { formatTaskDisplayName, normalizeTaskName } from '@core/features/tasks/api/task-names';
import { generateRandom } from '@core/features/tasks/node/name-generation/generateTaskName';
import {
  startControlMcpEndpoint,
  type ControlMcpEndpoint,
} from '@core/features/workspace-control/node/mcp-endpoint';
import {
  type ControlPullRequest,
  humanizeSlug,
  type WorkspaceControlDeps,
  WorkspaceControlService,
} from '@core/features/workspace-control/node/workspace-control-service';
import { workspaceRegistryTable as workspaces } from '@core/features/workspaces/api/node/registry/workspace-registry';
import { getProvisionedWorkspaceBranch } from '@core/features/workspaces/api/node/workspace-branch';
import type { Project } from '@core/primitives/projects/api';
import { resolveTaskBranchName } from '@core/primitives/tasks/api/resolve-task-branch-name';
import { buildWorkspaceConfigFromPreset } from '@core/primitives/workspaces/api/build-workspace-config-from-preset';
import { projects, tasks } from '@core/services/app-db/node/schema';
import { selectCurrentPr } from '@core/services/pull-requests/api';
import type { PullRequestsContract } from '@core/services/pull-requests/api/contract';
import type { PullRequestsRegistration } from '@core/services/pull-requests/node/pull-requests-registration';
import type { DesktopControllerContext } from './controllers';
import { getInitiativesService } from './initiatives';

const execFileAsync = promisify(execFile);

const AGENT_STATUS_RANK: Record<string, number> = {
  'awaiting-input': 4,
  working: 3,
  error: 2,
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

/** Starts the workspace control MCP endpoint over the app's own services. */
export async function startWorkspaceControl(
  context: DesktopControllerContext,
  extras: {
    pullRequests: ContractClient<PullRequestsContract>;
    pullRequestsRegistration: Pick<PullRequestsRegistration, 'repositoryUrlsForProject'>;
    /** Where the endpoint URL and token are published for local MCP clients. */
    endpointFile: string;
    version: string;
    logger: Logger;
    /** Subscribes to live agent status events; returns the unsubscribe function. */
    onAgentEvent?(
      handler: (event: {
        type: string;
        taskId: string;
        payload?: { notificationType?: string };
      }) => void
    ): () => void;
  }
): Promise<ControlMcpEndpoint> {
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

  // Push delivery: in an initiative with pushMessages on, each message or status event is fed
  // into the conversations of the tasks it reaches, labelled as coming from the feed rather than
  // the user. Events only reach tasks subscribed to them.
  const deliver = async (message: InitiativeMessage) => {
    const initiative = await initiatives.get(message.initiativeId);
    if (!initiative?.pushMessages || initiative.archived) return;
    // Direct messages, the user's posts, and what each task subscribed to (messageReachesTask).
    const targets = await initiatives.recipients(message);
    const names = await taskNames([
      ...targets,
      ...(message.fromTaskId ? [message.fromTaskId] : []),
    ]);
    const sender = message.fromTaskId ? `workspace "${names.get(message.fromTaskId)}"` : 'the user';
    const text =
      message.kind === 'event'
        ? `[Initiative "${initiative.name}" event, which you subscribed to.]\n\n${message.body}`
        : `[Initiative "${initiative.name}" message from ${sender}. It comes from the initiative ` +
          `feed, not directly from the user; weigh it accordingly.]\n\n${message.body}`;
    for (const taskId of targets) {
      const conversationId = await primaryConversation(taskId);
      if (!conversationId) continue;
      const sent = await sendAcpConversationPrompt(context, conversationId, text);
      if (!sent.success) log.warn('Initiative message delivery failed', { taskId });
    }
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
    const what =
      event.type === 'stop'
        ? 'finished its turn'
        : event.type === 'error'
          ? 'stopped with an error'
          : event.type === 'notification' && event.payload?.notificationType === 'permission_prompt'
            ? 'is waiting for the user to approve something'
            : null;
    if (!what) return;
    void (async () => {
      const initiative = await initiatives.initiativeOfTask(event.taskId);
      if (!initiative || initiative.archived) return;
      const name = (await taskNames([event.taskId])).get(event.taskId) ?? 'A workspace';
      await initiatives.post({
        initiativeId: initiative.id,
        fromTaskId: event.taskId,
        kind: 'event',
        body: `Workspace "${name}" ${what}.`,
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
        .select({ taskId: conversations.taskId, provider: conversations.provider })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      return row?.taskId ? { taskId: row.taskId, provider: row.provider ?? 'claude' } : null;
    },

    archiveWorkspace: (projectId, taskId) => taskService.archiveTask(projectId, taskId, telemetry),

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

      // The workspace shows the name as given; its branch needs the branch-safe form.
      const name = formatTaskDisplayName(humanizeSlug(input.name ?? '')) || generateRandom();
      const branchName = resolveTaskBranchName({
        rawBranch: normalizeTaskName(name) || generateRandom(),
        branchPrefix: projectSettings.branchPrefix,
        suffix: Math.random().toString(36).slice(2, 7),
        appendRandomSuffix: projectSettings.appendRandomBranchSuffix,
      });
      const provider = input.provider ?? (await appSettings.get('defaultAgent'));
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
                },
              }
            : {}),
        },
        workspaceConfig: buildWorkspaceConfigFromPreset(
          'new-worktree',
          { defaultBranch: fromBranch },
          { branchName, fromBranch }
        ),
      });
      if (!created.success)
        throw new Error(`Could not create the workspace: ${created.error.type}`);

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
  const endpoint = await startControlMcpEndpoint({
    service: new WorkspaceControlService(deps),
    endpointFile: extras.endpointFile,
    version: extras.version,
    onError: (error) => log.warn('Workspace control endpoint error', { error }),
  });
  return {
    info: endpoint.info,
    async close() {
      stopDelivery();
      stopEvents?.();
      await endpoint.close();
    },
  };
}
