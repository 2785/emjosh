import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import { taskManagerStoreToken } from '@core/features/tasks/contributions/browser/project-store-tokens';
import type { WorkbenchSidebarState } from '@core/features/workbench/contributions/mementos';
import type { MementoHandle } from '@core/primitives/mementos/browser';
import { SIDEBAR_GROUP_PAGE, SIDEBAR_GROUP_STEP, SidebarStore } from './sidebar-store';

type SidebarProjectManager = ConstructorParameters<typeof SidebarStore>[0];

vi.mock('@core/features/conversations/browser/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    conversationId = '';
    dispose() {}
    bootstrap() {}
  },
}));

vi.mock('@core/features/conversations/browser/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));

const initiativesState = vi.hoisted(() => ({
  initiatives: [] as { id: string; name: string; leadTaskId?: string | null }[],
}));
vi.mock('@core/features/initiatives/api/browser/initiatives-store', () => ({
  getInitiativesStore: () => ({
    initiatives: initiativesState.initiatives,
    byId: new Map(initiativesState.initiatives.map((i) => [i.id, i])),
  }),
}));

function projectManager(projects: { id: string; createdAt: string }[]): SidebarProjectManager {
  return {
    projects: new Map(projects.map((p) => [p.id, { ...p, context: null }])),
  } as unknown as SidebarProjectManager;
}

function task(id: string, createdAt: string) {
  return {
    state: 'provisioned',
    data: {
      id,
      type: 'coding-agent',
      isPinned: false,
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function projectManagerWithTasks(
  projects: { id: string; createdAt: string; taskIds: string[] }[]
): SidebarProjectManager {
  return {
    projects: new Map(
      projects.map((project) => {
        const taskManager = {
          tasks: new Map(
            project.taskIds.map((taskId, index) => [
              taskId,
              task(taskId, `2026-01-01T00:00:0${index}.000Z`),
            ])
          ),
        };
        return [
          project.id,
          {
            id: project.id,
            createdAt: project.createdAt,
            context: {
              kind: 'available',
              context: {
                get: (token: unknown) =>
                  token === taskManagerStoreToken ? taskManager : undefined,
              },
            },
          },
        ];
      })
    ),
  } as unknown as SidebarProjectManager;
}

function mementoHandle(initial: WorkbenchSidebarState): MementoHandle<WorkbenchSidebarState> {
  let value = initial;
  return {
    get value() {
      return value;
    },
    ready: Promise.resolve(),
    isPending: false,
    hasStoredValue: true,
    read: () => value,
    update: (next) => {
      value = typeof next === 'function' ? next(value) : next;
    },
    reset: async () => {},
    flush: async () => {},
    autoPersist: () =>
      (() => {}) as ReturnType<MementoHandle<WorkbenchSidebarState>['autoPersist']>,
    dispose: async () => {},
  };
}

describe('SidebarStore project ordering', () => {
  it('keeps a restored collapsed project collapsed during initial task hydration', () => {
    const tasks = observable.map<string, ReturnType<typeof task>>();
    const project = observable({
      id: 'project-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      context: null as null | {
        kind: 'available';
        context: { get: () => { tasks: typeof tasks } };
      },
    });
    const manager = {
      projects: observable.map([['project-1', project]]),
    } as unknown as SidebarProjectManager;
    const handle = mementoHandle({
      version: '1',
      expandedProjectIds: [],
      projectOrder: [],
      taskOrderByProject: {},
      taskSortBy: 'created-at',
      groupBy: 'project',
    });
    const store = new SidebarStore(manager);
    store.attachMemento(handle);

    runInAction(() => {
      project.context = {
        kind: 'available',
        context: { get: () => ({ tasks }) },
      };
    });
    runInAction(() => {
      tasks.set('task-1', task('task-1', '2026-01-01T00:00:00.000Z'));
    });

    expect([...store.expandedProjectIds]).toEqual([]);
    expect(handle.value.expandedProjectIds).toEqual([]);
  });

  it('reads and writes through an attached memento', () => {
    const store = new SidebarStore(projectManager([]));
    const handle = mementoHandle({
      version: '1',
      expandedProjectIds: ['project-1'],
      projectOrder: ['project-1'],
      taskOrderByProject: {},
      taskSortBy: 'updated-at',
      groupBy: 'project',
    });

    store.attachMemento(handle);
    expect([...store.expandedProjectIds]).toEqual(['project-1']);
    expect(store.taskSortBy).toBe('updated-at');

    store.setTaskSortBy('created-at');
    expect(handle.value.taskSortBy).toBe('created-at');
  });

  it('reveals a project without changing its persisted expansion preference', () => {
    const store = new SidebarStore(projectManager([{ id: 'project-1', createdAt: '2026-01-01' }]));
    const handle = mementoHandle({
      version: '1',
      expandedProjectIds: [],
      projectOrder: [],
      taskOrderByProject: {},
      taskSortBy: 'created-at',
      groupBy: 'project',
    });
    store.attachMemento(handle);

    store.revealProject('project-1');
    expect([...store.expandedProjectIds]).toEqual(['project-1']);
    expect(handle.value.expandedProjectIds).toEqual([]);

    store.toggleProjectExpanded('project-1');
    expect([...store.expandedProjectIds]).toEqual([]);
    expect(handle.value.expandedProjectIds).toEqual([]);
  });

  it('sorts projects newest first by default', () => {
    const store = new SidebarStore(
      projectManager([
        { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'new', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['new', 'old']);
  });

  it('places projects missing from a saved manual order first', () => {
    const store = new SidebarStore(
      projectManager([
        { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'manual', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'new', createdAt: '2026-01-03T00:00:00.000Z' },
      ])
    );

    store.setProjectOrder(['manual', 'old']);

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['new', 'manual', 'old']);
  });

  it('returns visible task entries in rendered project-tree order', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          taskIds: ['task-1a', 'task-1b'],
        },
        {
          id: 'project-2',
          createdAt: '2026-01-02T00:00:00.000Z',
          taskIds: ['task-2a'],
        },
      ])
    );

    store.setProjectOrder(['project-1', 'project-2']);
    store.toggleProjectExpanded('project-1');
    store.toggleProjectExpanded('project-2');
    store.setTaskOrder('project-1', ['task-1a', 'task-1b']);

    expect(store.visibleTaskEntries).toEqual([
      { projectId: 'project-1', taskId: 'task-1a' },
      { projectId: 'project-1', taskId: 'task-1b' },
      { projectId: 'project-2', taskId: 'task-2a' },
    ]);
  });

  it('excludes pinned automation runs from every sidebar selector', () => {
    const manager = projectManagerWithTasks([
      {
        id: 'project-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        taskIds: ['regular-task', 'automation-task'],
      },
    ]);
    const project = manager.projects.get('project-1')!;
    const context = project.context?.kind === 'available' ? project.context.context : undefined;
    const tasks = context!.get(taskManagerStoreToken).tasks;
    tasks.get('regular-task')!.data.isPinned = true;
    tasks.get('automation-task')!.data.isPinned = true;
    tasks.get('automation-task')!.data.type = 'automation-run';

    const store = new SidebarStore(manager);
    store.toggleProjectExpanded('project-1');

    expect(store.pinnedSidebarEntries).toEqual([
      { projectId: 'project-1', taskId: 'regular-task' },
    ]);
    expect(store.visibleTaskIdsForProject('project-1')).toEqual([]);
    expect(store.sidebarRows).toEqual([{ kind: 'project', projectId: 'project-1' }]);
  });
});

describe('SidebarStore grouping', () => {
  it('lists every task across projects in one sorted list when ungrouped', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        { id: 'project-a', createdAt: '2026-01-01T00:00:00.000Z', taskIds: ['a1', 'a2'] },
        { id: 'project-b', createdAt: '2026-01-02T00:00:00.000Z', taskIds: ['b1', 'b2', 'b3'] },
      ])
    );
    store.setGroupBy('none');

    // Tasks are created at :00, :01, :02 within each project; newest first, ties by id.
    expect(store.sidebarRows).toEqual([
      { kind: 'task', projectId: 'project-b', taskId: 'b3' },
      { kind: 'task', projectId: 'project-a', taskId: 'a2' },
      { kind: 'task', projectId: 'project-b', taskId: 'b2' },
      { kind: 'task', projectId: 'project-a', taskId: 'a1' },
      { kind: 'task', projectId: 'project-b', taskId: 'b1' },
    ]);
    expect(store.visibleTaskEntries.map((entry) => entry.taskId)).toEqual([
      'b3',
      'a2',
      'b2',
      'a1',
      'b1',
    ]);
  });

  it('groups by project by default and remembers the choice', () => {
    const store = new SidebarStore(projectManager([]));
    const handle = mementoHandle({ ...workbenchSidebarDefault(), groupBy: 'project' });
    store.attachMemento(handle);
    expect(store.groupBy).toBe('project');

    store.setGroupBy('none');

    expect(handle.value.groupBy).toBe('none');
  });
});

function workbenchSidebarDefault(): WorkbenchSidebarState {
  return {
    version: '1',
    expandedProjectIds: [],
    projectOrder: [],
    taskOrderByProject: {},
    taskSortBy: 'created-at',
    groupBy: 'project',
  };
}

describe('SidebarStore initiative grouping', () => {
  it('lists initiatives with their tasks from any project, then the rest under Other', () => {
    initiativesState.initiatives = [
      { id: 'i-accounts', name: 'Accounts v2' },
      { id: 'i-empty', name: 'Nothing yet' },
    ];
    const manager = projectManagerWithTasks([
      { id: 'api', createdAt: '2026-01-01T00:00:00.000Z', taskIds: ['api-1', 'api-2'] },
      { id: 'web', createdAt: '2026-01-02T00:00:00.000Z', taskIds: ['web-1'] },
    ]);
    const tasksOf = (projectId: string) =>
      (
        manager.projects.get(projectId) as unknown as {
          context: {
            context: {
              get: (token: unknown) => { tasks: Map<string, { data: Record<string, unknown> }> };
            };
          };
        }
      ).context.context.get(taskManagerStoreToken).tasks;
    tasksOf('api').get('api-1')!.data.initiativeId = 'i-accounts';
    tasksOf('web').get('web-1')!.data.initiativeId = 'i-accounts';
    tasksOf('api').get('api-2')!.data.initiativeId = 'i-archived-or-gone';
    const store = new SidebarStore(manager);
    store.setGroupBy('initiative');

    expect(store.sidebarRows).toEqual([
      { kind: 'initiative', initiativeId: 'i-accounts', label: 'Accounts v2', count: 2 },
      { kind: 'task', projectId: 'api', taskId: 'api-1' },
      { kind: 'task', projectId: 'web', taskId: 'web-1' },
      { kind: 'initiative', initiativeId: null, label: 'Other', count: 1 },
      { kind: 'task', projectId: 'api', taskId: 'api-2' },
    ]);
    expect(store.visibleTaskEntries.map((entry) => entry.taskId)).toEqual([
      'api-1',
      'web-1',
      'api-2',
    ]);
  });

  it("puts the initiative's lead first", () => {
    initiativesState.initiatives = [{ id: 'i-accounts', name: 'Accounts v2', leadTaskId: 'web-1' }];
    const manager = projectManagerWithTasks([
      { id: 'api', createdAt: '2026-01-01T00:00:00.000Z', taskIds: ['api-1'] },
      { id: 'web', createdAt: '2026-01-02T00:00:00.000Z', taskIds: ['web-1'] },
    ]);
    for (const [projectId, taskId] of [
      ['api', 'api-1'],
      ['web', 'web-1'],
    ] as const) {
      (
        manager.projects.get(projectId) as unknown as {
          context: {
            context: {
              get: (token: unknown) => { tasks: Map<string, { data: Record<string, unknown> }> };
            };
          };
        }
      ).context.context
        .get(taskManagerStoreToken)
        .tasks.get(taskId)!.data.initiativeId = 'i-accounts';
    }
    const store = new SidebarStore(manager);
    store.setGroupBy('initiative');

    expect(store.sidebarRows).toEqual([
      { kind: 'initiative', initiativeId: 'i-accounts', label: 'Accounts v2', count: 2 },
      { kind: 'task', projectId: 'web', taskId: 'web-1' },
      { kind: 'task', projectId: 'api', taskId: 'api-1' },
    ]);
  });

  it('shows a plain list when no task is in an initiative', () => {
    initiativesState.initiatives = [];
    const store = new SidebarStore(
      projectManagerWithTasks([
        { id: 'api', createdAt: '2026-01-01T00:00:00.000Z', taskIds: ['a'] },
      ])
    );
    store.setGroupBy('initiative');

    expect(store.sidebarRows).toEqual([{ kind: 'task', projectId: 'api', taskId: 'a' }]);
  });
});

describe('SidebarStore pagination', () => {
  const ids = Array.from({ length: 50 }, (_, i) => `t${String(i).padStart(2, '0')}`);
  const taskRows = (store: SidebarStore) =>
    store.sidebarRows.filter((row) => row.kind === 'task').length;

  it('lists a group’s first tasks and stands in for the rest with a "more" row', () => {
    initiativesState.initiatives = [];
    const store = new SidebarStore(
      projectManagerWithTasks([{ id: 'api', createdAt: '2026-01-01T00:00:00.000Z', taskIds: ids }])
    );
    store.setGroupBy('none');

    expect(taskRows(store)).toBe(SIDEBAR_GROUP_PAGE);
    expect(store.sidebarRows.at(-1)).toEqual({
      kind: 'more',
      groupKey: 'all',
      remaining: 50 - SIDEBAR_GROUP_PAGE,
      indent: 'none',
    });

    store.showMore('all');
    expect(taskRows(store)).toBe(SIDEBAR_GROUP_PAGE + SIDEBAR_GROUP_STEP);
    store.showMore('all');
    expect(taskRows(store)).toBe(50);
    expect(store.sidebarRows.some((row) => row.kind === 'more')).toBe(false);
  });

  it('keeps opened tasks and tasks needing attention listed beyond the limit', () => {
    initiativesState.initiatives = [];
    const store = new SidebarStore(
      projectManagerWithTasks([{ id: 'api', createdAt: '2026-01-01T00:00:00.000Z', taskIds: ids }]),
      (task) => task.data.id === 'needs-attention' || task.data.id === ids[0]
    );
    store.setGroupBy('none');
    const listed = () =>
      store.sidebarRows.flatMap((row) => (row.kind === 'task' ? [row.taskId] : []));
    const remainingIds = ids.filter((id) => !listed().includes(id));
    expect(remainingIds.length).toBeGreaterThan(0);

    store.revealTask(remainingIds[0]!);

    expect(listed()).toContain(remainingIds[0]);
    expect(listed()).toContain(ids[0]);
  });

  it('paginates each project on its own', () => {
    initiativesState.initiatives = [];
    const store = new SidebarStore(
      projectManagerWithTasks([
        { id: 'api', createdAt: '2026-01-01T00:00:00.000Z', taskIds: ids },
        { id: 'web', createdAt: '2026-01-02T00:00:00.000Z', taskIds: ['w1', 'w2'] },
      ])
    );
    store.expandAllProjects();

    expect(store.sidebarRows.filter((row) => row.kind === 'more')).toEqual([
      {
        kind: 'more',
        groupKey: 'project:api',
        remaining: 50 - SIDEBAR_GROUP_PAGE,
        indent: 'project',
      },
    ]);
  });
});
