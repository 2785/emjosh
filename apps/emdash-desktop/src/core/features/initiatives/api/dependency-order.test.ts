import { describe, expect, it } from 'vitest';
import { dependencyOrder, findCycle, type DependencyEdge } from './dependency-order';

const edge = (taskId: string, dependsOnTaskId: string): DependencyEdge => ({
  taskId,
  dependsOnTaskId,
});

describe('dependencyOrder', () => {
  it('ranks tasks topologically, parallel ones sharing a rank', () => {
    const order = dependencyOrder(
      ['A', 'B', 'C', 'D', 'E'],
      [edge('B', 'A'), edge('C', 'A'), edge('D', 'B'), edge('D', 'C')]
    );
    expect(Object.fromEntries(order.ranks)).toEqual({ A: 1, B: 2, C: 2, D: 3, E: 1 });
    expect(order.inCycle.size).toBe(0);
    expect(order.hasDependencies).toBe(true);
  });

  it('reports no dependencies when none are declared', () => {
    const order = dependencyOrder(['A', 'B'], []);
    expect(order.hasDependencies).toBe(false);
    expect(Object.fromEntries(order.ranks)).toEqual({ A: 1, B: 1 });
  });

  it('ignores edges to tasks outside the set', () => {
    const order = dependencyOrder(['A', 'B'], [edge('B', 'gone'), edge('outside', 'A')]);
    expect(order.hasDependencies).toBe(false);
  });

  it('marks cycle members and leaves tasks behind the cycle unranked', () => {
    const order = dependencyOrder(
      ['A', 'B', 'C', 'D'],
      [edge('A', 'B'), edge('B', 'A'), edge('C', 'B'), edge('B', 'D')]
    );
    expect([...order.inCycle].sort()).toEqual(['A', 'B']);
    expect(Object.fromEntries(order.ranks)).toEqual({ D: 1 });
  });
});

describe('findCycle', () => {
  it('finds the cycle a new dependency would create', () => {
    expect(findCycle([edge('B', 'A'), edge('C', 'B')], 'A', ['C'])).toEqual(['A', 'C', 'B', 'A']);
  });

  it('rejects depending on itself', () => {
    expect(findCycle([], 'A', ['A'])).toEqual(['A', 'A']);
  });

  it('replaces the task’s existing dependencies rather than adding to them', () => {
    // B used to depend on C; replacing that with A creates no cycle through C.
    expect(findCycle([edge('B', 'C'), edge('C', 'A')], 'B', ['A'])).toBeNull();
    expect(findCycle([edge('B', 'C'), edge('C', 'A')], 'A', ['B'])).toEqual(['A', 'B', 'C', 'A']);
  });

  it('allows diamonds', () => {
    expect(findCycle([edge('B', 'A'), edge('C', 'A')], 'D', ['B', 'C'])).toBeNull();
  });
});
