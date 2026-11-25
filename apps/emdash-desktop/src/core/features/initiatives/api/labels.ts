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

/** How agents' messages name a workspace: `Workspace F "Codex parity"`, or without a label. */
export function workspaceRef(name: string, label?: string | null): string {
  return `Workspace ${labelledName(name, label)}`;
}

/** A workspace's quoted name after its label, if any: `F "Codex parity"`. */
export function labelledName(name: string, label?: string | null): string {
  return label ? `${label} "${name}"` : `"${name}"`;
}
