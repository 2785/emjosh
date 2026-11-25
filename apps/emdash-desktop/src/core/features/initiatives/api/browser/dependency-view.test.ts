import { describe, expect, it, vi } from 'vitest';
import type { Initiative } from '../contract';
import { taskDependencyView } from './dependency-view';

vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ projects: new Map([['p', {}]]) }),
}));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskManagerStore: () => ({
    tasks: new Map(['api', 'web'].map((id) => [id, { data: { name: id.toUpperCase() } }])),
  }),
}));

const initiative = (dependencies: Initiative['dependencies']): Initiative => ({
  id: 'i',
  name: 'Accounts v2',
  pushMessages: true,
  archived: false,
  createdAt: '2026-11-25',
  taskIds: ['lead', 'api', 'web', 'solo'],
  labels: {},
  leadTaskId: 'lead',
  dependencies,
});

describe('taskDependencyView', () => {
  it('shows only tasks that are part of a dependency', () => {
    const accounts = initiative([{ taskId: 'web', dependsOnTaskId: 'api', doneNotice: null }]);

    expect(taskDependencyView(accounts, 'web')).toEqual({
      rank: 2,
      inCycle: false,
      dependsOn: [{ taskId: 'api', name: 'API', looksDone: null }],
    });
    expect(taskDependencyView(accounts, 'api')).toEqual({ rank: 1, inCycle: false, dependsOn: [] });
    expect(taskDependencyView(accounts, 'solo')).toBeUndefined();
    expect(taskDependencyView(accounts, 'lead')).toBeUndefined();
  });

  it('shows nothing in an initiative without dependencies', () => {
    expect(taskDependencyView(initiative([]), 'api')).toBeUndefined();
  });
});
