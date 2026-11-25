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
