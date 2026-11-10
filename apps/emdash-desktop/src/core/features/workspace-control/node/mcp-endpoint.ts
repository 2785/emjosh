import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ControlCaller, WorkspaceControlService } from './workspace-control-service';

/** Header an Emjosh agent session sends to identify the conversation it runs in. */
export const CALLER_CONVERSATION_HEADER = 'x-emjosh-conversation';

/** Written to the endpoint file so local MCP clients can find and authenticate to Emjosh. */
export type ControlEndpointInfo = { url: string; token: string };

/** Added to agents' system prompts by MCP clients such as Claude Code. */
export const CONTROL_MCP_INSTRUCTIONS = `You are running in an Emjosh workspace: a branch and worktree of one repository with its own agent chat. These tools manage workspaces and initiatives (groups of workspaces across repositories working towards one goal). Use them as described below without waiting to be asked.

- Name your workspace once, first. New workspaces get placeholder names such as "dull-geese-try". As soon as you understand the task, before starting the work, call rename_workspace with a short name for it in plain words, the way you would title the work (for example "Remove sandbox access expiry"), not a branch-style slug. Later messages are almost always follow-ups to that work (corrections, details, related questions), so keep the name; rename again only if the user asks, or the conversation has pivoted to something with nothing in common with what the workspace started as.
- Split work across repositories into an initiative. When the task also needs changes in other repositories (an API and its UI, a library and its users), don't make those changes from this workspace; you lead, and a workspace per repository does its part:
  - Call current_workspace. If it has no initiative, create one with create_initiative (it includes this workspace and delivers messages into every member's chat). If it has one, make sure its pushMessages is true, or call set_message_delivery, so the others actually receive what you send.
  - For each other repository (find it with list_projects; if it isn't a project yet, add it with add_project or clone_project), call create_workspace with that initiativeId and a self-contained prompt: the goal, that repository's part, the contract the parts must agree on (API shapes, field names, rollout order), that it belongs to the initiative led by your workspace (give your workspace id), and that it should post_message to you when it is done, blocked, or needs a decision. Tell the user which workspaces you started.
  - Coordinate through the initiative. Messaging is opt-in: a workspace receives messages addressed to it (and the user's posts), and broadcasts or status events only if it subscribed. So address messages with toWorkspaceId instead of broadcasting, and subscribe only to what you need, for example to the status events of the workspaces you started (subscribe with topic 'events' and their ids). With delivery on, what reaches you arrives in your chat, even after your turn ends, so you don't need to poll; call wait_for_messages only when you can't continue without an answer.
  - Don't do another workspace's work on its branch. If one seems stuck or silent, check list_workspaces (agent status) and read_messages, message it, and ask the user before taking over its work.
- If you were started as part of an initiative (current_workspace shows one and your first prompt names a lead), do your part, and post_message to the lead (toWorkspaceId) when you finish, get blocked, or need a decision. Don't broadcast or subscribe unless your work needs other workspaces' updates. Check read_messages before ending a turn so instructions sent mid-turn aren't missed.
- Keep work that belongs in this repository here; don't create workspaces for it.
- Waiting on something outside this chat (CI pipelines, deploys, reviews, another workspace): nothing tells you when it finishes, and once your turn ends nobody is watching it. Run a background shell loop that checks every 30 to 60 seconds and exits when it is done or after a time limit (about 45 minutes), so its exit is what wakes you, for example \`until <check>; do sleep 30; done\`. Don't end your turn to wait, and don't schedule long or repeated wakeups to poll: each one re-reads the whole conversation.
- If current_workspace returns null, you are not running inside an Emjosh workspace, and the points above about workspaces and initiatives don't apply.`;

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** MCP tools over the control service, bound to one caller. */
export function buildControlMcpServer(
  service: WorkspaceControlService,
  caller: ControlCaller,
  version: string
): McpServer {
  const server = new McpServer(
    { name: 'emjosh', version },
    { instructions: CONTROL_MCP_INSTRUCTIONS }
  );

  server.registerTool(
    'list_projects',
    {
      description: 'List the projects (repositories) open in Emjosh.',
      inputSchema: {},
    },
    async () => json(await service.listProjects())
  );

  server.registerTool(
    'add_project',
    {
      description:
        'Add an existing local directory (usually a git repository) to Emjosh as a project, so ' +
        'workspaces can be created in it.',
      inputSchema: {
        path: z.string().min(1).describe('Absolute path of the directory.'),
        name: z.string().optional().describe("Project name; the directory's name when omitted."),
      },
    },
    async (input) => json(await service.addProject(input))
  );

  server.registerTool(
    'clone_project',
    {
      description:
        "Clone a git repository and add it as a project. Uses the machine's git credentials.",
      inputSchema: {
        repositoryUrl: z.string().min(1).describe('HTTPS or SSH clone URL.'),
        name: z.string().optional().describe("Project name; the repository's name when omitted."),
        parentDirectory: z
          .string()
          .optional()
          .describe("Directory to clone into; Emjosh's repositories folder when omitted."),
      },
    },
    async (input) => json(await service.cloneProject(input))
  );

  server.registerTool(
    'rename_project',
    {
      description: 'Rename a project in Emjosh (the directory on disk keeps its name).',
      inputSchema: { projectId: z.string(), name: z.string().min(1) },
    },
    async (input) => {
      await service.renameProject(input);
      return json({ renamed: true });
    }
  );

  server.registerTool(
    'remove_project',
    {
      description:
        'Remove a project from Emjosh. Its repository files stay on disk, but its workspaces ' +
        '(and their worktrees, with any uncommitted work) are removed. Only when the user ' +
        'explicitly asks; refuses projects with open workspaces unless includeWorkspaces is true.',
      inputSchema: {
        projectId: z.string(),
        includeWorkspaces: z
          .boolean()
          .optional()
          .describe('Also remove its open workspaces; only if the user confirmed that.'),
      },
    },
    async (input) => json(await service.removeProject(caller, input))
  );

  server.registerTool(
    'list_workspaces',
    {
      description:
        'List Emjosh workspaces (tasks: a branch/worktree with its agent conversations) with ' +
        'their branch, agent status, last activity, and pull request state.',
      inputSchema: {
        projectId: z.string().optional().describe('Only workspaces of this project.'),
        includeArchived: z.boolean().optional().describe('Include archived workspaces.'),
      },
    },
    async (input) => json(await service.listWorkspaces(input))
  );

  server.registerTool(
    'current_workspace',
    {
      description: 'Describe the workspace this conversation is running in.',
      inputSchema: {},
    },
    async () => json(await service.currentWorkspace(caller))
  );

  server.registerTool(
    'rename_workspace',
    {
      description:
        'Name the workspace this conversation runs in after its work. Replaces only the ' +
        'generated placeholder name unless override is true.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe('Short name in plain words, e.g. "Fix login redirect" (not a branch name).'),
        override: z
          .boolean()
          .optional()
          .describe(
            'Replace a name that is not a placeholder. Only when the user asks for a rename, or ' +
              'the work has pivoted to something unrelated to what the workspace started as; ' +
              'follow-ups to the same work are not a pivot.'
          ),
      },
    },
    async (input) => json(await service.renameWorkspace(caller, input))
  );

  server.registerTool(
    'archive_workspaces',
    {
      description:
        'Archive workspaces (reversible from Emjosh). The calling workspace is never archived. ' +
        'Confirm with the user before archiving anything they did not explicitly ask for.',
      inputSchema: { workspaceIds: z.array(z.string()).min(1) },
    },
    async ({ workspaceIds }) => json(await service.archiveWorkspaces(caller, workspaceIds))
  );

  server.registerTool(
    'create_workspace',
    {
      description:
        'Create a workspace in a project: a new branch and worktree, optionally with a first ' +
        'prompt for its agent, which starts working right away.',
      inputSchema: {
        projectId: z.string(),
        name: z.string().optional().describe('Workspace name; generated when omitted.'),
        baseBranch: z
          .string()
          .optional()
          .describe("Branch to start from; the project's default branch when omitted."),
        prompt: z.string().optional().describe('First message for the new workspace agent.'),
        provider: z
          .string()
          .optional()
          .describe("Agent to run (e.g. 'claude'); defaults to the calling workspace's agent."),
        initiativeId: z
          .string()
          .optional()
          .describe(
            "Initiative to put it in, e.g. the calling workspace's (see current_workspace)."
          ),
      },
    },
    async (input) => json(await service.createWorkspace(caller, input))
  );

  server.registerTool(
    'list_initiatives',
    {
      description:
        'List initiatives: optional groups of workspaces across projects working towards one ' +
        'goal (e.g. one change needing pull requests in several repositories).',
      inputSchema: {},
    },
    async () => json(await service.listInitiatives())
  );

  server.registerTool(
    'create_initiative',
    {
      description:
        'Create an initiative grouping workspaces across projects. Includes the calling ' +
        'workspace unless includeCallingWorkspace is false. Messages are delivered into the ' +
        "members' chats unless pushMessages is false.",
      inputSchema: {
        name: z.string(),
        workspaceIds: z.array(z.string()).optional(),
        includeCallingWorkspace: z.boolean().optional(),
        pushMessages: z
          .boolean()
          .optional()
          .describe(
            "Deliver messages into members' chats (default true). Without it, a workspace " +
              'only sees messages when it calls read_messages or wait_for_messages.'
          ),
      },
    },
    async (input) => json(await service.createInitiative(caller, input))
  );

  server.registerTool(
    'set_message_delivery',
    {
      description:
        "Turn delivery of an initiative's messages into its workspaces' chats on or off. With " +
        'it off, a workspace only sees messages when it calls read_messages or wait_for_messages.',
      inputSchema: {
        enabled: z.boolean(),
        initiativeId: z.string().optional().describe("Defaults to the caller's initiative."),
      },
    },
    async (input) => json(await service.setMessageDelivery(caller, input))
  );

  server.registerTool(
    'add_to_initiative',
    {
      description: 'Move workspaces into an initiative.',
      inputSchema: { initiativeId: z.string(), workspaceIds: z.array(z.string()).min(1) },
    },
    async (input) => json(await service.addToInitiative(input))
  );

  server.registerTool(
    'remove_from_initiative',
    {
      description: 'Take workspaces out of their initiative.',
      inputSchema: { workspaceIds: z.array(z.string()).min(1) },
    },
    async (input) => json(await service.removeFromInitiative(input))
  );

  const topicSchema = z
    .enum(['messages', 'events'])
    .describe(
      "'messages': broadcasts other workspaces post to everyone. 'events': app status updates " +
        '(a workspace finished its turn, needs approval, or failed).'
    );
  const fromSchema = z
    .array(z.string())
    .optional()
    .describe('Only from these workspaces; omit for every workspace in the initiative.');

  server.registerTool(
    'subscribe',
    {
      description:
        "Choose to receive more of your initiative's feed. By default a workspace only gets " +
        "messages addressed to it (and the user's posts); subscribe to broadcasts or status " +
        'events, from specific workspaces or all of them, only as far as your work needs.',
      inputSchema: {
        topic: topicSchema,
        fromWorkspaceIds: fromSchema,
        initiativeId: z.string().optional(),
      },
    },
    async (input) => json(await service.setSubscription(caller, { ...input, subscribe: true }))
  );

  server.registerTool(
    'unsubscribe',
    {
      description:
        'Stop receiving a topic from the given workspaces, or the whole topic when none are given.',
      inputSchema: {
        topic: topicSchema,
        fromWorkspaceIds: fromSchema,
        initiativeId: z.string().optional(),
      },
    },
    async (input) => json(await service.setSubscription(caller, { ...input, subscribe: false }))
  );

  server.registerTool(
    'list_subscriptions',
    {
      description:
        'What this workspace receives in its initiative beyond messages addressed to it.',
      inputSchema: { initiativeId: z.string().optional() },
    },
    async (input) => json(await service.listSubscriptions(caller, input))
  );

  server.registerTool(
    'post_message',
    {
      description:
        "Post to your initiative's message feed. Prefer addressing one workspace " +
        '(toWorkspaceId): direct messages always arrive. Messages to everyone only reach ' +
        "workspaces that subscribed to the sender's broadcasts.",
      inputSchema: {
        text: z.string(),
        toWorkspaceId: z
          .string()
          .optional()
          .describe('The workspace to tell; omit only for a broadcast to subscribers.'),
        initiativeId: z.string().optional().describe("Defaults to the caller's initiative."),
      },
    },
    async (input) => json(await service.postMessage(caller, input))
  );

  server.registerTool(
    'read_messages',
    {
      description:
        'Read messages for you in your initiative (to you or everyone, including app events ' +
        'such as a workspace finishing its turn). Pass the last id you saw as afterId.',
      inputSchema: {
        afterId: z.string().optional(),
        initiativeId: z.string().optional(),
      },
    },
    async (input) => json(await service.readMessages(caller, input))
  );

  server.registerTool(
    'wait_for_messages',
    {
      description:
        'Wait until a message for you arrives in your initiative, then return the new ones ' +
        '(empty after the timeout). Use it to coordinate with other workspaces.',
      inputSchema: {
        afterId: z.string().optional(),
        timeoutSeconds: z.number().int().min(1).max(300).optional(),
        initiativeId: z.string().optional(),
      },
    },
    async (input) => json(await service.waitForMessages(caller, input))
  );

  return server;
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function callerFrom(req: IncomingMessage): ControlCaller {
  const header = req.headers[CALLER_CONVERSATION_HEADER];
  const conversationId = Array.isArray(header) ? header[0] : header;
  return { conversationId: conversationId?.trim() || null };
}

export type ControlMcpEndpoint = {
  readonly info: ControlEndpointInfo;
  close(): Promise<void>;
};

/**
 * Serves the control MCP tools on loopback at `/mcp`, stateless (one server per request).
 * Requests must carry the bearer token from the endpoint file, which only the user can read.
 */
export async function startControlMcpEndpoint(options: {
  service: WorkspaceControlService;
  endpointFile: string;
  version: string;
  onError?(error: unknown): void;
}): Promise<ControlMcpEndpoint> {
  const token = randomBytes(32).toString('base64url');

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.split('?')[0] !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (!bearerMatches(req.headers.authorization, token)) {
      res.writeHead(401).end();
      return;
    }
    const mcp = buildControlMcpServer(options.service, callerFrom(req), options.version);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      options.onError?.(error);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const info: ControlEndpointInfo = { url: `http://127.0.0.1:${port}/mcp`, token };
  await writeFile(options.endpointFile, JSON.stringify(info), { mode: 0o600 });
  await chmod(options.endpointFile, 0o600);

  return {
    info,
    async close() {
      await rm(options.endpointFile, { force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
