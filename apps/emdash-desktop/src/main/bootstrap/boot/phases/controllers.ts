import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Scope } from '@emdash/shared/concurrency';
import { connect, memoryTransportPair, type Connection, type Controller } from '@emdash/wire/rpc';
import { app } from 'electron';
import { startInterruptedTurnResumer } from '@core/features/conversations/node/interrupted-turns';
import {
  sendAcpConversationPrompt,
  startAcpConversationSession,
} from '@core/features/conversations/node/wire-controller';
import {
  desktopNodeControllers,
  type DesktopControllerContext,
} from '@core/manifests/node/controllers';
import { startWorkspaceControl } from '@core/manifests/node/workspace-control';
import { desktopDomainContracts } from '@core/manifests/shared/domain-contracts';
import { IS_PERSONAL } from '@core/primitives/app-identity/api/app-identity';
import { agentStatusService } from '@main/core/agent-status/agent-status-service';
import { controlEndpointFile } from '@main/core/workspace-control/endpoint-file';
import { createClaudeSearchModel } from '@main/core/workspace-control/search-model';
import type { DesktopRuntimes } from '@main/gateway/desktop-runtimes';
import { serveDesktopWire } from '@main/gateway/desktop-wire';
import { getRemoteControlService } from '@main/host/remote-control';
import { log } from '@main/lib/logger';
import { buildLaunchedToolEnv } from '@main/lib/userEnv';
import { appScope } from '../../core/app-scope';
import { createDesktopWireOptions } from '../wiring';
import type { DatabaseBundle } from './database';
import type { InfrastructureBundle } from './infrastructure';
import type { ServicesBundle } from './services';

export type ControllersBundle = {
  readonly controllers: Record<string, Controller>;
  readonly scope: Scope;
};

export async function bootControllers(
  database: DatabaseBundle,
  infrastructure: InfrastructureBundle,
  runtimes: DesktopRuntimes,
  services: ServicesBundle
): Promise<ControllersBundle> {
  if (import.meta.env.DEV) assertDomainKeyParity();
  const options = createDesktopWireOptions(database, services, runtimes);
  const scope = appScope.child('desktop-controllers');
  try {
    const entries = await Promise.all(
      Object.entries(desktopNodeControllers).map(async ([domain, contribution]) => {
        const controllerScope = scope.child(`controller:${domain}`);
        const context: DesktopControllerContext = {
          ...options,
          hosts: infrastructure.hosts,
          runtimes: runtimes.broker,
          scope: controllerScope,
          ssh: infrastructure.ssh,
        };
        const controller = await contribution.create(context);
        if (controller.dispose) controllerScope.add(() => controller.dispose?.());
        return [domain, controller] as const;
      })
    );
    const sessionOptions = { ...options, runtimes: runtimes.broker };
    scope.add(
      startInterruptedTurnResumer({
        db: database.db,
        projects: services.projects,
        isEnabled: () => database.appSettings.get('resumeInterruptedTurns'),
        start: (conversationId) => startAcpConversationSession(sessionOptions, conversationId),
        send: (conversationId, text) =>
          sendAcpConversationPrompt(sessionOptions, conversationId, text),
        logger: log,
      })
    );
    if (IS_PERSONAL) {
      // Agents manage workspaces through this endpoint; a failure only disables that.
      try {
        const endpoint = await startWorkspaceControl(
          {
            ...options,
            hosts: infrastructure.hosts,
            runtimes: runtimes.broker,
            scope,
            ssh: infrastructure.ssh,
          },
          {
            pullRequests: runtimes.clients.pullRequests,
            pullRequestsRegistration: services.pullRequestsRegistration,
            appWire: inProcessDesktopWire(scope),
            endpointFile: controlEndpointFile(),
            version: app.getVersion(),
            logger: log,
            onAgentEvent: (handler) => agentStatusService.on('agent:event', handler),
            transcripts: {
              acpHistory: join(app.getPath('userData'), 'acp-history'),
              claudeProjects: join(
                process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
                'projects'
              ),
            },
            runSearchModel: createClaudeSearchModel({ env: buildLaunchedToolEnv }),
          }
        );
        scope.add(() => endpoint.close());
        getRemoteControlService().setWorkspaceControl(endpoint.service);
      } catch (error) {
        log.warn('Workspace control endpoint did not start', { error });
      }
      // Remote control (off unless turned on in settings) and its push notifications.
      const remoteControl = getRemoteControlService();
      scope.add(services.notifications.registerSink(remoteControl.pushSink()));
      scope.add(() => remoteControl.dispose());
      void remoteControl
        .initialize()
        .catch((error: unknown) => log.warn('Remote control did not start', { error }));
    }
    return { controllers: Object.fromEntries(entries), scope };
  } catch (error) {
    await scope.dispose(error);
    throw error;
  }
}

function assertDomainKeyParity(): void {
  const contractDomains = Object.keys(desktopDomainContracts).sort();
  const controllerDomains = Object.keys(desktopNodeControllers).sort();
  if (
    contractDomains.length === controllerDomains.length &&
    contractDomains.every((domain, index) => domain === controllerDomains[index])
  ) {
    return;
  }

  const contractSet = new Set(contractDomains);
  const controllerSet = new Set(controllerDomains);
  const missingControllers = contractDomains.filter((domain) => !controllerSet.has(domain));
  const unknownControllers = controllerDomains.filter((domain) => !contractSet.has(domain));
  throw new Error(
    `Desktop Wire domain mismatch: missing controllers [${missingControllers.join(
      ', '
    )}], unknown controllers [${unknownControllers.join(', ')}]`
  );
}

/**
 * The desktop wire served in-process, connected on first use: agents reach the app through the
 * same calls and live states as the window.
 */
function inProcessDesktopWire(scope: Scope) {
  let connection: Connection | null = null;
  const open = (): Connection => {
    if (connection) return connection;
    const pair = memoryTransportPair();
    scope.add(serveDesktopWire(pair.right));
    // Long operations (cloning, deleting) run past the default call deadline.
    connection = connect(pair.left, { callTimeoutMs: 10 * 60_000 });
    scope.add(() => connection?.dispose());
    return connection;
  };
  return {
    call: (path: string, input: unknown) => open().call(path, input),
    snapshot: (topic: string) => open().snapshot(topic),
  };
}
