import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import type { Initiative } from '../contract';
import { dependencyOrder, type DependencyOrder } from '../dependency-order';

export type TaskDependencyView = {
  /** 1 lands first; null on or behind a cycle. */
  rank: number | null;
  inCycle: boolean;
  dependsOn: { taskId: string; name: string; looksDone: string | null }[];
};

const orders = new WeakMap<Initiative, DependencyOrder>();

/** The initiative's dependency order; recomputed only when the initiative object changes. */
export function initiativeDependencyOrder(initiative: Initiative): DependencyOrder {
  let order = orders.get(initiative);
  if (!order) {
    order = dependencyOrder(initiative.taskIds, initiative.dependencies);
    orders.set(initiative, order);
  }
  return order;
}

/**
 * Where a task sits in its initiative's order; undefined unless it is part of a dependency (it
 * depends on a task, or a task depends on it).
 */
export function taskDependencyView(
  initiative: Initiative,
  taskId: string
): TaskDependencyView | undefined {
  const linked = initiative.dependencies.some(
    (dependency) => dependency.taskId === taskId || dependency.dependsOnTaskId === taskId
  );
  if (!linked) return undefined;
  const order = initiativeDependencyOrder(initiative);
  return {
    rank: order.ranks.get(taskId) ?? null,
    inCycle: order.inCycle.has(taskId),
    dependsOn: initiative.dependencies
      .filter((dependency) => dependency.taskId === taskId)
      .map((dependency) => ({
        taskId: dependency.dependsOnTaskId,
        name: taskName(dependency.dependsOnTaskId) ?? 'a removed workspace',
        looksDone: dependency.doneNotice,
      })),
  };
}

function taskName(taskId: string): string | undefined {
  for (const projectId of getProjectManagerStore().projects.keys()) {
    const task = getTaskManagerStore(projectId)?.tasks.get(taskId);
    if (task) return task.data.name;
  }
  return undefined;
}
