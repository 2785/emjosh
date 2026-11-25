/** Logos shown at most per sidebar row; the tooltip still names every agent. */
export const MAX_SIDEBAR_AGENT_LOGOS = 2;

/**
 * Agents a task runs other than the default one, most-used first.
 *
 * @example nonDefaultAgentIds({ claude: 2, codex: 1 }, 'claude') // ['codex']
 * @example nonDefaultAgentIds({ claude: 1 }, 'claude') // []
 */
export function nonDefaultAgentIds(
  conversationStats: Record<string, number>,
  defaultAgentId: string | undefined
): string[] {
  return Object.entries(conversationStats)
    .filter(([id, count]) => count > 0 && id !== defaultAgentId)
    .sort(([, a], [, b]) => b - a)
    .map(([id]) => id);
}
