import type { WorkspaceRef } from '../api/workspace-search';
import { parseSearchQuery, type SearchableWorkspace } from './workspace-search';

/** A passage of an initiative feed or a chat transcript that mentions the query. */
export type SearchSnippet = {
  workspaceId: string | null;
  source: 'feed' | 'chat';
  text: string;
};

/** Words and literals worth looking for in feeds and transcripts. */
export function snippetTerms(query: string): string[] {
  const parsed = parseSearchQuery(query);
  const terms = new Set<string>();
  if (parsed.url) {
    // The path identifies a PR/MR however it is written (with or without host, /diffs...).
    const path = parsed.url.replace(/^[^/]+\//, '');
    terms.add(path.toLowerCase());
  } else if (parsed.pullRequest) {
    terms.add(`merge_requests/${parsed.pullRequest.number}`);
    terms.add(`pull/${parsed.pullRequest.number}`);
  }
  for (const ticket of parsed.tickets) terms.add(ticket);
  // Short words match too much transcript noise to be useful.
  if (!parsed.pullRequest)
    for (const term of parsed.terms) if (term.length >= 4 || /\d/.test(term)) terms.add(term);
  return [...terms];
}

const SNIPPET_RADIUS = 160;

/**
 * Up to `limit` passages of `text` around occurrences of `terms` (lowercase), most distinct
 * terms first. JSON escapes and runs of whitespace are flattened so transcripts read as text.
 */
export function findSnippets(text: string, terms: readonly string[], limit = 3): string[] {
  if (terms.length === 0 || !text) return [];
  const lower = text.toLowerCase();
  const found: { at: number; term: string }[] = [];
  for (const term of terms) {
    let from = 0;
    let count = 0;
    while (count < limit) {
      const at = lower.indexOf(term, from);
      if (at < 0) break;
      found.push({ at, term });
      from = at + term.length;
      count += 1;
    }
  }
  found.sort((a, b) => a.at - b.at);
  const passages: { start: number; end: number; terms: Set<string> }[] = [];
  for (const { at, term } of found) {
    const start = Math.max(0, at - SNIPPET_RADIUS);
    const end = Math.min(text.length, at + term.length + SNIPPET_RADIUS);
    const last = passages.at(-1);
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
      last.terms.add(term);
    } else {
      passages.push({ start, end, terms: new Set([term]) });
    }
  }
  return passages
    .sort((a, b) => b.terms.size - a.terms.size)
    .slice(0, limit)
    .map((passage) => flatten(text.slice(passage.start, passage.end)));
}

function flatten(text: string): string {
  return text
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** How many of `terms` occur in `text` (lowercase); ranks transcripts before taking snippets. */
export function termHits(text: string, terms: readonly string[]): number {
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term)).length;
}

export const ASK_SYSTEM_PROMPT = `You help the user find a workspace in Emjosh, an app where each workspace is a git branch and worktree with its own AI agent chat. Workspaces belong to projects (repositories) and may be grouped into initiatives. The user describes the workspace they want: a PR/MR URL or number, a branch, a ticket, a file, or what the work was about.

Answer only from the data you are given: the workspace list, and passages from initiative feeds and chat transcripts that mention the query. A workspace that opened or owns a PR is a better answer than one that merely mentions it (initiative leads and reviewers mention PRs they didn't open). If nothing fits, say so.

Reply with JSON only, no prose around it:
{"answer": "<one or two sentences>", "workspaces": [{"id": "<workspace id from the list>", "why": "<short reason>"}]}
List the best match first and at most 5 workspaces.`;

function describe(workspace: WorkspaceRef & { actualBranch?: string | null }): string {
  const pr = workspace.pullRequest;
  return [
    workspace.id,
    `"${workspace.name}"`,
    `project ${workspace.projectName}`,
    workspace.branch ? `branch ${workspace.branch}` : null,
    workspace.actualBranch && workspace.actualBranch !== workspace.branch
      ? `checked out ${workspace.actualBranch}`
      : null,
    workspace.initiativeName ? `initiative "${workspace.initiativeName}"` : null,
    pr ? `PR ${pr.url} "${pr.title}" (${pr.state})` : null,
    workspace.archived ? 'archived' : null,
    workspace.markedDone ? 'done' : null,
    workspace.lastActivityAt ? `last active ${workspace.lastActivityAt.slice(0, 10)}` : null,
  ]
    .filter(Boolean)
    .join(' | ');
}

export function buildAskPrompt(input: {
  query: string;
  workspaces: readonly SearchableWorkspace[];
  snippets: readonly SearchSnippet[];
}): string {
  const names = new Map(input.workspaces.map((workspace) => [workspace.id, workspace.name]));
  const passages = input.snippets.map((snippet) => {
    const owner = snippet.workspaceId
      ? `${snippet.workspaceId} "${names.get(snippet.workspaceId) ?? '?'}"`
      : 'Emjosh';
    return `[${snippet.source} of ${owner}] ${snippet.text}`;
  });
  return [
    `The user is looking for: ${input.query}`,
    '',
    'Workspaces (id | name | details):',
    ...input.workspaces.map(describe),
    '',
    passages.length > 0
      ? 'Passages mentioning the query:'
      : 'No feed or chat passages mention the query.',
    ...passages,
  ].join('\n');
}

/**
 * The agent's reply: its answer and the workspaces it named, keeping only ids that exist.
 * Tolerates code fences and text around the JSON; a reply that isn't JSON becomes the answer.
 */
export function parseAskResponse(
  reply: string,
  knownIds: ReadonlySet<string>
): { answer: string; workspaces: { id: string; why: string | null }[] } {
  const trimmed = reply.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  let parsed: unknown = null;
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { answer: trimmed || 'The agent gave no answer.', workspaces: [] };
  }
  const record = parsed as { answer?: unknown; workspaces?: unknown };
  const seen = new Set<string>();
  const workspaces = (Array.isArray(record.workspaces) ? record.workspaces : []).flatMap(
    (entry: unknown) => {
      const item =
        typeof entry === 'string' ? { id: entry } : (entry as { id?: unknown; why?: unknown });
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!knownIds.has(id) || seen.has(id)) return [];
      seen.add(id);
      return [
        { id, why: typeof item.why === 'string' && item.why.trim() ? item.why.trim() : null },
      ];
    }
  );
  const answer = typeof record.answer === 'string' ? record.answer.trim() : '';
  return { answer: answer || 'The agent gave no answer.', workspaces: workspaces.slice(0, 5) };
}
