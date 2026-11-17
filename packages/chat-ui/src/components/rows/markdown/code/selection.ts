/** Marks a code line element, so a selection's text can be rebuilt line by line. */
export const CODE_LINE_ATTR = 'data-code-line';

/**
 * The selected text of a code block, one line per line element. Code lines are absolutely
 * positioned, so the browser's own copy runs them together without newlines.
 * Null when the selection covers no code lines.
 */
export function selectedCodeText(range: Range, root: Element): string | null {
  const lines = [...root.querySelectorAll(`[${CODE_LINE_ATTR}]`)].filter((line) =>
    range.intersectsNode(line)
  );
  if (lines.length === 0) return null;
  return lines
    .map((line) => {
      const part = document.createRange();
      part.selectNodeContents(line);
      if (line.contains(range.startContainer)) {
        part.setStart(range.startContainer, range.startOffset);
      }
      if (line.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset);
      return part.toString();
    })
    .join('\n');
}
