import { createEventStreamHost } from '@emdash/wire/live';
import { createController, type Controller } from '@emdash/wire/rpc';
import { initiativesContract } from '../api/contract';
import type { InitiativesService } from './initiatives-service';

export function createInitiativesWireController(service: InitiativesService): Controller {
  const events = createEventStreamHost(initiativesContract.events);
  const unsubscribe = service.onChange((change) => events.emit(undefined, change));
  const controller = createController(initiativesContract, {
    list: (input) => service.list(input),
    create: ({ name }) => service.create(name),
    update: ({ id, ...changes }) => service.update(id, changes),
    setLead: ({ initiativeId, taskId }) => service.setLead(initiativeId, taskId),
    setTaskInitiative: ({ taskIds, initiativeId }) =>
      service.setTaskInitiative(taskIds, initiativeId),
    messages: (input) => service.messages(input),
    post: ({ initiativeId, body, toTaskId }) =>
      service.post({ initiativeId, fromTaskId: null, toTaskId, body }),
    events,
  });
  return {
    ...controller,
    dispose: async () => {
      unsubscribe();
      await controller.dispose?.();
    },
  };
}
