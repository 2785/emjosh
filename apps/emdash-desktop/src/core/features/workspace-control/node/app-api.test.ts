import { describe, expect, it, vi } from 'vitest';
import { desktopWireContract } from '@core/manifests/shared/desktop-wire-contract';
import { AppApi, appApiCatalog } from './app-api';

function setup() {
  const wire = {
    call: vi.fn(async (_path: string, _input: unknown) => 'called' as unknown),
    snapshot: vi.fn(async (_topic: string) => ({ data: ['task'] as unknown })),
  };
  return { api: new AppApi(appApiCatalog(desktopWireContract), wire), wire };
}

describe('app API', () => {
  it('lists every domain of the app, filterable by path', () => {
    const { api } = setup();
    const paths = api.list().map((entry) => entry.path);
    for (const path of [
      'appSettings.update',
      'automations.create',
      'mcp.saveServer',
      'skills.install',
      'projects.createProject',
      'tasks.taskList.restore',
      'tasks.taskList.list',
    ]) {
      expect(paths).toContain(path);
    }
    expect(api.list('automations').every((entry) => entry.path.includes('automations'))).toBe(true);
  });

  it('describes inputs as JSON Schema', () => {
    const { api } = setup();
    expect(api.describe('tasks.taskList.restore')).toMatchObject({
      kind: 'mutation',
      key: { type: 'object', properties: { projectId: { type: 'string' } } },
      input: { type: 'object', properties: { taskId: { type: 'string' } } },
    });
  });

  it('calls procedures directly and mutations with their key', async () => {
    const { api, wire } = setup();
    await api.call('appSettings.update', { key: 'interface', value: {} });
    expect(wire.call).toHaveBeenCalledWith('appSettings.update', {
      key: 'interface',
      value: {},
    });

    await api.call('tasks.taskList.restore', { taskId: 't1' }, { projectId: 'p1' });
    expect(wire.call).toHaveBeenLastCalledWith('tasks.taskList.restore', {
      key: { projectId: 'p1' },
      input: { taskId: 't1' },
      mutationId: expect.any(String),
    });
    await expect(api.call('tasks.taskList.restore', { taskId: 't1' })).rejects.toThrow();
  });

  it('addresses every live state by its full topic, under its domain', () => {
    const states = appApiCatalog(desktopWireContract).filter((entry) => entry.kind === 'state');
    expect(states.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        'conversations.acp.session.state',
        'conversations.providerSettings.model.value',
      ])
    );
    for (const entry of states) {
      if (entry.kind !== 'state') continue;
      expect(entry.topicId.split('.')[0]).toBe(entry.path.split('.')[0]);
    }
  });

  it('reads live states by key and rejects unknown paths', async () => {
    const { api, wire } = setup();
    expect(await api.read('tasks.taskList.list', { projectId: 'p1' })).toEqual(['task']);
    expect(wire.snapshot).toHaveBeenCalledWith(expect.stringContaining('"projectId":"p1"'));
    await expect(api.call('nope.nothing', {})).rejects.toThrow(/Unknown app API path/);
    await expect(api.read('appSettings.update')).rejects.toThrow(/not a live state/);
  });
});
