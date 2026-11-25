import type {
  WorkspaceRef,
  WorkspaceSearchHit,
  WorkspaceSearchResult,
} from '../api/workspace-search';

/** A workspace with everything the deterministic search matches against. */
export type SearchableWorkspace = WorkspaceRef & {
  /** The branch its worktree has checked out, when it differs from the stored one. */
  actualBranch?: string | null;
};

export type ParsedQuery = {
  raw: string;
  /** Lowercased, trimmed. */
  text: string;
  /** A PR/MR the query points at (URL, "!5799", "#12", "PR 12", or a bare number). */
  pullRequest: {
    /** Normalised URL (see normalizePullRequestUrl), when the query was one. */
    url?: string;
    /** "group/sub/repo" of the URL. */
    repoPath?: string;
    number: number;
  } | null;
  /** Any URL in the query, normalised. */
  url: string | null;
  /** Ticket ids such as "KRAK-123", lowercased. */
  tickets: string[];
  /** Words to match against names, branches, titles. */
  terms: string[];
};

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'in',
  'is',
  'it',
  'of',
  'on',
  'one',
  'the',
  'that',
  'this',
  'to',
  'which',
  'with',
  'workspace',
  'where',
  'what',
]);

/**
 * "https://GitLab.com/G/repo/-/merge_requests/5799/diffs?x#y" → "gitlab.com/g/repo/-/merge_requests/5799".
 * Lowercased, as forges treat paths case-insensitively. Null when it isn't a URL.
 */
export function normalizePullRequestUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const path = url.pathname.replace(/\/+$/, '');
  const pr = /^(.*?\/(?:-\/merge_requests|pull|pulls|pull-requests)\/\d+)(?:\/.*)?$/.exec(path);
  return `${url.host}${pr ? pr[1] : path}`.toLowerCase();
}

/** The repository path and number of a PR/MR URL (GitHub, GitLab, Bitbucket, Forgejo). */
export function parsePullRequestUrl(input: string): { repoPath: string; number: number } | null {
  const normalized = normalizePullRequestUrl(input);
  if (!normalized) return null;
  const match = /^[^/]+\/(.+?)(?:\/-)?\/(?:merge_requests|pull|pulls|pull-requests)\/(\d+)$/.exec(
    normalized
  );
  if (!match) return null;
  return { repoPath: match[1]!.toLowerCase(), number: Number(match[2]) };
}

export function parseSearchQuery(raw: string): ParsedQuery {
  const text = raw.trim().toLowerCase();
  const urlMatch = /https?:\/\/\S+/i.exec(raw);
  const url = urlMatch ? normalizePullRequestUrl(urlMatch[0]) : null;
  const fromUrl = urlMatch ? parsePullRequestUrl(urlMatch[0]) : null;
  let pullRequest: ParsedQuery['pullRequest'] = null;
  if (fromUrl && url) {
    pullRequest = { url, repoPath: fromUrl.repoPath, number: fromUrl.number };
  } else if (!urlMatch) {
    const ref = /^(?:(?:pr|mr|pull request|merge request)\s*[#!]?\s*|[#!])(\d+)$/i.exec(text);
    const bare = /^\d+$/.exec(text);
    const number = ref ? Number(ref[1]) : bare ? Number(text) : NaN;
    if (Number.isInteger(number) && number > 0) pullRequest = { number };
  }
  const tickets = [...text.matchAll(/\b([a-z][a-z0-9]{1,9}-\d+)\b/g)].map((m) => m[1]!);
  const withoutUrls = text.replace(/https?:\/\/\S+/g, ' ');
  const terms = [
    ...new Set(
      withoutUrls
        .split(/[^a-z0-9._/-]+/)
        .map((term) => term.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
        .filter((term) => term.length >= 2 && !STOPWORDS.has(term))
    ),
  ];
  return { raw, text, pullRequest, url, tickets, terms };
}

/** "Fix self-partner recon_search" → ["fix", "self", "partner", "recon", "search"]. */
function words(value: string | null | undefined): string[] {
  return (value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function contains(haystack: string | null | undefined, needle: string): boolean {
  return !!haystack && haystack.toLowerCase().includes(needle);
}

type Scored = { score: number; reasons: string[] };

function add(scored: Scored, score: number, reason: string) {
  scored.score += score;
  if (!scored.reasons.includes(reason)) scored.reasons.push(reason);
}

function prLabel(workspace: WorkspaceRef): string {
  const pr = workspace.pullRequest;
  if (!pr?.number) return 'PR';
  return /merge_requests/.test(pr.url) ? `MR !${pr.number}` : `PR #${pr.number}`;
}

/**
 * How well one workspace matches. `mentions` are workspaces whose chat mentions the query's
 * URL or PR, a weaker signal (leads and reviewers mention PRs they didn't open).
 */
export function scoreWorkspace(
  query: ParsedQuery,
  workspace: SearchableWorkspace,
  mentions: ReadonlySet<string> = new Set()
): Scored {
  const scored: Scored = { score: 0, reasons: [] };
  const { text } = query;
  if (!text) return scored;
  const branches = [workspace.branch, workspace.actualBranch].filter(
    (branch): branch is string => !!branch
  );
  const pr = workspace.pullRequest;

  // Identity: ids, PR/MR, branch, exact name.
  if (workspace.id.toLowerCase() === text) add(scored, 100, 'id');
  else if (text.length >= 6 && /^[0-9a-f-]+$/.test(text) && workspace.id.startsWith(text))
    add(scored, 80, 'id');
  if (workspace.initiativeId && workspace.initiativeId.toLowerCase() === text)
    add(scored, 40, 'initiative id');

  if (query.pullRequest && pr) {
    const prUrl = normalizePullRequestUrl(pr.url);
    if (query.pullRequest.url && prUrl === query.pullRequest.url) {
      add(scored, 100, prLabel(workspace));
    } else if (pr.number === query.pullRequest.number) {
      const repo = parsePullRequestUrl(pr.url)?.repoPath;
      if (query.pullRequest.repoPath) {
        if (repo === query.pullRequest.repoPath) add(scored, 100, prLabel(workspace));
      } else {
        add(scored, 70, prLabel(workspace));
      }
    }
  }
  if (query.url && !query.pullRequest && pr && normalizePullRequestUrl(pr.url) === query.url) {
    add(scored, 100, prLabel(workspace));
  }
  if (mentions.has(workspace.id)) add(scored, 30, 'mentioned in its chat');

  if (branches.some((branch) => branch.toLowerCase() === text)) add(scored, 95, 'branch');
  else if (text.length >= 4 && !query.url && branches.some((branch) => contains(branch, text)))
    add(scored, 50, 'branch');

  for (const ticket of query.tickets) {
    if (branches.some((branch) => contains(branch, ticket)) || contains(workspace.name, ticket))
      add(scored, 70, ticket.toUpperCase());
    else if (contains(pr?.title, ticket)) add(scored, 60, ticket.toUpperCase());
  }

  const name = workspace.name.toLowerCase();
  if (name === text) add(scored, 90, 'name');
  else if (text.length >= 3 && name.includes(text)) add(scored, 60, 'name');
  if (workspace.projectName.toLowerCase() === text) add(scored, 30, 'project');
  if (workspace.initiativeName?.toLowerCase() === text) add(scored, 30, 'initiative');

  // Words: the share of the query's words found somewhere, weighted by where.
  if (query.terms.length > 0 && !query.url) {
    const fields: [string[], number, string][] = [
      [words(workspace.name), 1, 'name'],
      [branches.flatMap(words), 0.9, 'branch'],
      [words(pr?.title), 0.8, 'PR title'],
      [words(workspace.initiativeName), 0.5, 'initiative'],
      [words(workspace.projectName), 0.5, 'project'],
    ];
    let total = 0;
    const matchedIn = new Set<string>();
    for (const term of query.terms) {
      const termWords = words(term);
      let best = 0;
      let where = '';
      for (const [fieldWords, weight, label] of fields) {
        const found = termWords.every((tw) =>
          fieldWords.some((fw) => fw === tw || (tw.length >= 4 && fw.startsWith(tw)))
        );
        if (found && weight > best) {
          best = weight;
          where = label;
        }
      }
      total += best;
      if (where) matchedIn.add(where);
    }
    const share = total / query.terms.length;
    // Half the words, at least, so one common word doesn't list every workspace.
    if (share >= 0.5) {
      scored.score += Math.round(share * 50);
      for (const where of matchedIn)
        if (!scored.reasons.includes(where)) scored.reasons.push(where);
    }
  }
  return scored;
}

export const CONCLUSIVE_SCORE = 80;

const STATUS_RANK: Record<string, number> = {
  'awaiting-input': 3,
  working: 3,
  background: 2,
  error: 1,
};

/** Tie-break rank: higher is more likely what the user means (active, then recently used). */
export function compareByActivity(
  a: Pick<WorkspaceRef, 'archived' | 'agentStatus' | 'lastActivityAt'>,
  b: Pick<WorkspaceRef, 'archived' | 'agentStatus' | 'lastActivityAt'>
): number {
  return (
    Number(a.archived) - Number(b.archived) ||
    (STATUS_RANK[b.agentStatus ?? ''] ?? 0) - (STATUS_RANK[a.agentStatus ?? ''] ?? 0) ||
    (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '')
  );
}

/** Ranks workspaces for a query; ties go to active, then recently used workspaces. */
export function searchWorkspaces(
  raw: string,
  workspaces: readonly SearchableWorkspace[],
  options: { mentions?: ReadonlySet<string>; limit?: number } = {}
): WorkspaceSearchResult {
  const query = parseSearchQuery(raw);
  const hits: WorkspaceSearchHit[] = [];
  for (const workspace of workspaces) {
    const { score, reasons } = scoreWorkspace(query, workspace, options.mentions);
    if (score <= 0) continue;
    const { actualBranch: _actual, ...ref } = workspace;
    hits.push({ workspace: ref, score, reasons });
  }
  hits.sort((a, b) => b.score - a.score || compareByActivity(a.workspace, b.workspace));
  const limited = hits.slice(0, options.limit ?? 20);
  return { query: raw, hits: limited, conclusive: isConclusive(limited) };
}

/** One strong hit, well ahead of the next. */
export function isConclusive(hits: readonly WorkspaceSearchHit[]): boolean {
  const [top, next] = hits;
  if (!top || top.score < CONCLUSIVE_SCORE) return false;
  return !next || next.score <= top.score - 30;
}
