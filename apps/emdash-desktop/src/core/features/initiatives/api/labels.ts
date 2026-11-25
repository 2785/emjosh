import {
  parseWorkspaceLink,
  workspaceLink as workspaceLinkHref,
} from '@core/features/workspace-control/api/workspace-search';

/** Longest label, e.g. "API" or "UI-2". */
export const MAX_LABEL_LENGTH = 6;

/**
 * A workspace's label as stored: trimmed and upper-cased. Throws for anything that isn't 1 to
 * MAX_LABEL_LENGTH letters, digits or dashes, starting with a letter or digit.
 */
export function normalizeLabel(raw: string): string {
  const label = raw.trim().toUpperCase();
  if (!new RegExp(`^[A-Z0-9][A-Z0-9-]{0,${MAX_LABEL_LENGTH - 1}}$`).test(label)) {
    throw new Error(
      `A label is 1 to ${MAX_LABEL_LENGTH} letters, digits or dashes (e.g. "F" or "API"); got "${raw}".`
    );
  }
  return label;
}

/** The first label in A…Z, AA, AB… that isn't in `issued`. */
export function nextLabel(issued: ReadonlySet<string>): string {
  for (let n = 0; ; n++) {
    const label = spreadsheetLetters(n);
    if (!issued.has(label)) return label;
  }
}

/** 0 → "A", 25 → "Z", 26 → "AA". */
function spreadsheetLetters(n: number): string {
  let label = '';
  for (let rest = n + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    label = String.fromCharCode(65 + ((rest - 1) % 26)) + label;
  }
  return label;
}

/** A workspace's label as a markdown link that opens it: `[F](emjosh://workspace/<id>)`. */
export function workspaceLink(id: string, label: string): string {
  return `[${label}](${workspaceLinkHref(id)})`;
}

/**
 * A ready-made markdown link to a workspace: its label when it has one, else its name. Chat
 * shows it as a button that opens the workspace.
 */
export function workspaceChip(id: string, name: string, label?: string | null): string {
  return workspaceLink(id, label || name.replace(/[[\]]/g, ''));
}

/** How agents' messages name a workspace: `Workspace [F](link) "Codex parity"`. */
export function workspaceRef(name: string, label?: string | null, id?: string): string {
  return `Workspace ${labelledName(name, label, id)}`;
}

/**
 * A workspace's quoted name after its label, if any: `F "Codex parity"`. With an id the label
 * is a link that opens the workspace.
 */
export function labelledName(name: string, label?: string | null, id?: string): string {
  if (!label) return `"${name}"`;
  return `${id ? workspaceLink(id, label) : label} "${name}"`;
}

export type MessagePart = { text: string } | { label: string; workspaceId: string };

/** Splits a message into plain text and `[label](emjosh://workspace/<id>)` links. */
export function splitWorkspaceLinks(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;
  for (const match of text.matchAll(/\[([^\]]+)\]\((emjosh:\/\/workspace\/[^)\s]+)\)/gi)) {
    const workspaceId = parseWorkspaceLink(match[2]!);
    if (!workspaceId) continue;
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ label: match[1]!, workspaceId });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
