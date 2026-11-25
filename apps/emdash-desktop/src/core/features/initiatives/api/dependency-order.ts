/** "taskId depends on dependsOnTaskId": dependsOnTaskId should land first. */
export type DependencyEdge = { taskId: string; dependsOnTaskId: string };

export type DependencyOrder = {
  /**
   * 1 for tasks depending on nothing, else one more than the highest rank they depend on; tasks
   * that can run in parallel share a rank. Missing for tasks in or behind a cycle.
   */
  ranks: Map<string, number>;
  /** Tasks on a dependency cycle. */
  inCycle: Set<string>;
  /** False when no task declares a dependency: there is no order to show. */
  hasDependencies: boolean;
};

/**
 * Ranks `taskIds` by their declared dependencies. Edges with an end outside `taskIds` are
 * ignored.
 *
 * @example
 * // B and C depend on A, D depends on B and C:
 * dependencyOrder(['A', 'B', 'C', 'D'], edges).ranks // A→1, B→2, C→2, D→3
 */
export function dependencyOrder(
  taskIds: readonly string[],
  edges: readonly DependencyEdge[]
): DependencyOrder {
  const members = new Set(taskIds);
  const dependsOn = new Map<string, Set<string>>(taskIds.map((id) => [id, new Set()]));
  for (const edge of edges) {
    if (members.has(edge.taskId) && members.has(edge.dependsOnTaskId)) {
      dependsOn.get(edge.taskId)!.add(edge.dependsOnTaskId);
    }
  }
  const hasDependencies = [...dependsOn.values()].some((deps) => deps.size > 0);

  const ranks = new Map<string, number>();
  // Repeatedly rank tasks whose dependencies are all ranked; what's left is in or behind a cycle.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, deps] of dependsOn) {
      if (ranks.has(id) || ![...deps].every((dep) => ranks.has(dep))) continue;
      ranks.set(id, 1 + Math.max(0, ...[...deps].map((dep) => ranks.get(dep)!)));
      progressed = true;
    }
  }

  const inCycle = new Set<string>();
  for (const id of taskIds) {
    if (!ranks.has(id) && reaches(dependsOn, id, id)) inCycle.add(id);
  }
  return { ranks, inCycle, hasDependencies };
}

/**
 * The cycle that giving `taskId` the dependencies `dependsOnTaskIds` would create, as a path
 * from `taskId` back to itself; null when there is none.
 *
 * @example
 * // B depends on A; making A depend on B:
 * findCycle([{ taskId: 'B', dependsOnTaskId: 'A' }], 'A', ['B']) // ['A', 'B', 'A']
 */
export function findCycle(
  edges: readonly DependencyEdge[],
  taskId: string,
  dependsOnTaskIds: readonly string[]
): string[] | null {
  const dependsOn = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.taskId === taskId) continue;
    const deps = dependsOn.get(edge.taskId) ?? new Set<string>();
    deps.add(edge.dependsOnTaskId);
    dependsOn.set(edge.taskId, deps);
  }
  dependsOn.set(taskId, new Set(dependsOnTaskIds));

  const path: string[] = [taskId];
  const visited = new Set<string>();
  const walk = (id: string): boolean => {
    for (const dep of dependsOn.get(id) ?? []) {
      if (dep === taskId) {
        path.push(dep);
        return true;
      }
      if (visited.has(dep)) continue;
      visited.add(dep);
      path.push(dep);
      if (walk(dep)) return true;
      path.pop();
    }
    return false;
  };
  return walk(taskId) ? path : null;
}

function reaches(dependsOn: Map<string, Set<string>>, from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [...(dependsOn.get(from) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(dependsOn.get(id) ?? []));
  }
  return false;
}
