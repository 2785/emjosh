/**
 * Finding a workspace from free text (a PR/MR URL or number, a branch, an id, a ticket, words
 * from its name) and linking to workspaces from chat text.
 *
 * Agents name a workspace as a markdown link with the workspace scheme, which chats render as a
 * clickable chip: `[Fix login redirect](emjosh://workspace/3f2c…)`.
 */

export const WORKSPACE_LINK_PREFIX = 'emjosh://workspace/';

export function workspaceLink(workspaceId: string): string {
  return `${WORKSPACE_LINK_PREFIX}${encodeURIComponent(workspaceId)}`;
}

/** The workspace id of an `emjosh://workspace/<id>` link; null for any other href. */
export function parseWorkspaceLink(href: string): string | null {
  if (!href.toLowerCase().startsWith(WORKSPACE_LINK_PREFIX)) return null;
  const rest = href.slice(WORKSPACE_LINK_PREFIX.length).split(/[/?#]/)[0] ?? '';
  try {
    const id = decodeURIComponent(rest).trim();
    return id || null;
  } catch {
    return null;
  }
}

export type WorkspaceRef = {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  initiativeId: string | null;
  initiativeName: string | null;
  branch: string | null;
  archived: boolean;
  agentStatus: string | null;
  markedDone: boolean;
  lastActivityAt: string | null;
  pullRequest: { url: string; number?: number; title: string; state: string } | null;
};

export type WorkspaceSearchHit = {
  workspace: WorkspaceRef;
  score: number;
  /** What matched, e.g. "PR !5799", "branch", "mentioned in its chat". */
  reasons: string[];
};

export type WorkspaceSearchResult = {
  query: string;
  hits: WorkspaceSearchHit[];
  /** One hit clearly stands out, so there is no need to ask an agent. */
  conclusive: boolean;
};

export type WorkspaceAskResult = {
  query: string;
  answer: string;
  workspaces: (WorkspaceRef & { why: string | null })[];
};

/** One run of the agent search: its real steps so far, and its result once done. */
export type WorkspaceAskStatus = {
  runId: string;
  query: string;
  /** Epoch ms the run started; the UI shows elapsed time from it. */
  startedAt: number;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  /** What it is doing right now, in plain words. */
  step: string;
  /** Steps already finished, oldest first. */
  completed: string[];
  result?: WorkspaceAskResult;
  error?: string;
};

/**
 * Whether palette text reads like a description of work (a URL, PR number, ticket id, or three
 * or more words) rather than a command or name being typed; such text offers the agent search
 * as the top result.
 */
export function isFreeTextQuery(query: string): boolean {
  const text = query.trim();
  if (/https?:\/\//i.test(text)) return true;
  if (/^(?:(?:pr|mr)\s*)?[#!]\d+$/i.test(text)) return true;
  if (/\b[a-z][a-z0-9]{1,9}-\d+\b/i.test(text)) return true;
  return text.split(/\s+/).filter(Boolean).length >= 3;
}
