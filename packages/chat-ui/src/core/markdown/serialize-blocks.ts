import type { Block, InlineRun, ProseBlock } from './document';
import { mentionDisplayText } from './document';

/**
 * Parsed message blocks back to markdown and HTML, for copying out of the chat: the transcript
 * renders laid-out spans, so the browser's own copy carries no structure.
 */

function inlineMarkdown(runs: readonly InlineRun[]): string {
  return runs
    .map((run) => {
      switch (run.kind) {
        case 'break':
          return '  \n';
        case 'code':
          return `\`${run.text}\``;
        case 'mention':
          return mentionDisplayText(run);
        case 'text': {
          let text = run.text;
          if (run.bold && run.italic) text = `***${text}***`;
          else if (run.bold) text = `**${text}**`;
          else if (run.italic) text = `*${text}*`;
          return run.href ? `[${text}](${run.href})` : text;
        }
      }
    })
    .join('');
}

function proseMarkdown(block: ProseBlock): string {
  const text = inlineMarkdown(block.runs);
  const depth = block.depth ?? 0;
  if (block.variant.startsWith('h')) return `${'#'.repeat(Number(block.variant[1]))} ${text}`;
  if (block.variant === 'list-item') return `${'  '.repeat(depth)}${block.marker ?? '-'} ${text}`;
  if (block.variant === 'quote') return `${'> '.repeat(Math.max(1, depth))}${text}`;
  return text;
}

export function blocksToMarkdown(blocks: readonly Block[]): string {
  const parts: string[] = [];
  // Within a run of list items: whether the list at each depth is numbered.
  let numberedAtDepth: boolean[] = [];
  blocks.forEach((block, index) => {
    let tight = false;
    if (block.kind === 'prose' && block.variant === 'list-item') {
      const depth = block.depth ?? 0;
      const numbered = block.marker !== undefined;
      const known = numberedAtDepth[depth];
      // Items continue the list unless the list type at their depth changes.
      tight =
        index > 0 && numberedAtDepth.length > 0 && (known === undefined || known === numbered);
      if (!tight) numberedAtDepth = [];
      numberedAtDepth.length = depth + 1;
      numberedAtDepth[depth] = numbered;
    } else {
      numberedAtDepth = [];
    }
    if (index > 0) parts.push(tight ? '\n' : '\n\n');
    switch (block.kind) {
      case 'prose':
        parts.push(proseMarkdown(block));
        break;
      case 'code':
        parts.push(`\`\`\`${block.lang ?? ''}\n${block.code}\n\`\`\``);
        break;
      case 'mermaid':
        parts.push(`\`\`\`mermaid\n${block.source}\n\`\`\``);
        break;
      case 'rule':
        parts.push('---');
        break;
      case 'table': {
        const row = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
        parts.push(
          [row(block.header), row(block.header.map(() => '---')), ...block.rows.map(row)].join('\n')
        );
        break;
      }
    }
  });
  return parts.join('');
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inlineHtml(runs: readonly InlineRun[]): string {
  return runs
    .map((run) => {
      switch (run.kind) {
        case 'break':
          return '<br>';
        case 'code':
          return `<code>${escapeHtml(run.text)}</code>`;
        case 'mention':
          return escapeHtml(mentionDisplayText(run));
        case 'text': {
          let html = escapeHtml(run.text);
          if (run.italic) html = `<em>${html}</em>`;
          if (run.bold) html = `<strong>${html}</strong>`;
          return run.href ? `<a href="${escapeHtml(run.href)}">${html}</a>` : html;
        }
      }
    })
    .join('');
}

export function blocksToHtml(blocks: readonly Block[]): string {
  const out: string[] = [];
  // Open lists, innermost last: their tag and depth.
  const lists: { tag: 'ul' | 'ol'; depth: number }[] = [];
  const closeListsDeeperThan = (depth: number) => {
    while (lists.length > 0 && lists.at(-1)!.depth > depth) out.push(`</${lists.pop()!.tag}>`);
  };
  for (const block of blocks) {
    if (block.kind === 'prose' && block.variant === 'list-item') {
      const depth = block.depth ?? 0;
      const tag = block.marker ? 'ol' : 'ul';
      closeListsDeeperThan(depth);
      const open = lists.at(-1);
      if (open && open.depth === depth && open.tag !== tag) out.push(`</${lists.pop()!.tag}>`);
      if (!lists.at(-1) || lists.at(-1)!.depth < depth) {
        out.push(`<${tag}>`);
        lists.push({ tag, depth });
      }
      out.push(`<li>${inlineHtml(block.runs)}</li>`);
      continue;
    }
    closeListsDeeperThan(-1);
    switch (block.kind) {
      case 'prose': {
        const html = inlineHtml(block.runs);
        if (block.variant.startsWith('h')) out.push(`<${block.variant}>${html}</${block.variant}>`);
        else if (block.variant === 'quote') out.push(`<blockquote><p>${html}</p></blockquote>`);
        else out.push(`<p>${html}</p>`);
        break;
      }
      case 'code':
        out.push(`<pre><code>${escapeHtml(block.code)}</code></pre>`);
        break;
      case 'mermaid':
        out.push(`<pre><code>${escapeHtml(block.source)}</code></pre>`);
        break;
      case 'rule':
        out.push('<hr>');
        break;
      case 'table': {
        const cells = (tag: string, values: readonly string[]) =>
          values.map((value) => `<${tag}>${escapeHtml(value)}</${tag}>`).join('');
        out.push(
          `<table><thead><tr>${cells('th', block.header)}</tr></thead><tbody>${block.rows
            .map((row) => `<tr>${cells('td', row)}</tr>`)
            .join('')}</tbody></table>`
        );
        break;
      }
    }
  }
  closeListsDeeperThan(-1);
  return out.join('');
}
