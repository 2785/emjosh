import { normalizeBrowserUrl } from '@core/primitives/browser/api';

/** Browser profile agents use; never the user's own profile, so agents can't reach its logins. */
export const AGENT_BROWSER_PROFILE_ID = 'agent';

/** Pages one workspace may keep open at once. */
export const AGENT_BROWSER_MAX_PAGES = 6;

/** Pages with no tool call for this long are closed. */
export const AGENT_BROWSER_IDLE_MS = 30 * 60 * 1000;

/** Longest snapshot or console text returned to an agent. */
export const AGENT_BROWSER_MAX_TEXT = 60_000;

export type AgentPageInfo = {
  pageId: string;
  url: string;
  title: string;
  loading: boolean;
};

export type AgentPageAction =
  | { type: 'click'; ref: string; doubleClick?: boolean }
  | { type: 'type'; ref: string; text: string; submit?: boolean; append?: boolean }
  | { type: 'select'; ref: string; option: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; direction: 'up' | 'down' | 'top' | 'bottom' }
  | { type: 'wait'; text?: string; textGone?: string; ms?: number; timeoutMs?: number };

export type AgentConsoleEntry = { level: string; text: string };

/**
 * Pages agents drive through the control MCP server, scoped to one workspace (`scope`).
 * `pageId` defaults to the workspace's most recently used page.
 */
export interface AgentBrowserPort {
  open(scope: string, input: { url: string; show?: boolean }): Promise<AgentPageInfo>;
  pages(scope: string): AgentPageInfo[];
  navigate(
    scope: string,
    pageId: string | undefined,
    input: { url?: string; action?: 'back' | 'forward' | 'reload' }
  ): Promise<AgentPageInfo>;
  snapshot(
    scope: string,
    pageId: string | undefined
  ): Promise<{ page: AgentPageInfo; text: string }>;
  screenshot(
    scope: string,
    pageId: string | undefined,
    input: { fullPage?: boolean }
  ): Promise<{ page: AgentPageInfo; pngBase64: string }>;
  act(
    scope: string,
    pageId: string | undefined,
    action: AgentPageAction
  ): Promise<{ page: AgentPageInfo; detail?: string }>;
  console(
    scope: string,
    pageId: string | undefined,
    input: { clear?: boolean }
  ): Promise<{ page: AgentPageInfo; entries: AgentConsoleEntry[] }>;
  show(scope: string, pageId: string | undefined): Promise<AgentPageInfo>;
  close(scope: string, pageId: string | undefined): Promise<{ closed: string }>;
}

/** http(s) and about:blank only: agents get no file:, chrome: or custom-scheme pages. */
export function normalizeAgentUrl(input: string): string {
  const normalized = normalizeBrowserUrl(input, { allowSearchQueries: false });
  if (!normalized.ok) throw new Error(`Can't open "${input}": ${normalized.reason}.`);
  return normalized.url;
}

const REF_PATTERN = /^e\d{1,6}$/;

export function assertAgentRef(ref: string): string {
  if (!REF_PATTERN.test(ref)) {
    throw new Error(
      `"${ref}" isn't an element ref. Refs look like e12 and come from browser_snapshot.`
    );
  }
  return ref;
}

export function truncateAgentText(text: string, max = AGENT_BROWSER_MAX_TEXT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]`;
}

export type AgentKeyEvent = {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
};

const NAMED_KEYS: Record<string, AgentKeyEvent> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
};

/** The key event for a key name ("Enter", "ArrowDown") or a single character ("a"). */
export function agentKeyEvent(name: string): AgentKeyEvent {
  const named = NAMED_KEYS[name];
  if (named) return named;
  if (Array.from(name).length === 1) {
    const upper = name.toUpperCase();
    const isAlnum = /^[A-Za-z0-9]$/.test(name);
    return {
      key: name,
      code: isAlnum ? (/^\d$/.test(name) ? `Digit${name}` : `Key${upper}`) : '',
      windowsVirtualKeyCode: isAlnum ? upper.charCodeAt(0) : 0,
      text: name,
    };
  }
  throw new Error(
    `Unknown key "${name}". Use a single character or one of: ${Object.keys(NAMED_KEYS).join(', ')}.`
  );
}

/**
 * Page script that numbers the visible interactive elements (tagging each with `data-emjosh-ref`)
 * and returns an outline of the page as text. Runs in the page's own world.
 */
export const AGENT_SNAPSHOT_SCRIPT = `(() => {
  document.querySelectorAll('[data-emjosh-ref]').forEach((el) => el.removeAttribute('data-emjosh-ref'));
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'SVG', 'PATH']);
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=combobox],[role=textbox],[role=option],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const BLOCK_TEXT = new Set(['P', 'LI', 'TD', 'TH', 'LABEL', 'SPAN', 'DIV', 'DT', 'DD', 'FIGCAPTION', 'BLOCKQUOTE', 'PRE', 'CODE', 'EM', 'STRONG']);
  const lines = [];
  let count = 0;
  const clip = (s, n) => { s = (s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'input') return el.type === 'checkbox' || el.type === 'radio' ? el.type : el.type === 'submit' || el.type === 'button' ? 'button' : 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    return tag === 'summary' ? 'button' : tag;
  };
  const nameOf = (el) => {
    const labelled = el.getAttribute('aria-label');
    if (labelled) return labelled;
    if (el.labels && el.labels.length) return el.labels[0].innerText;
    return el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') ||
      (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button') ? el.value : '') ||
      el.innerText || el.textContent || '';
  };
  const walk = (node, depth) => {
    for (const el of node.children) {
      if (SKIP.has(el.tagName.toUpperCase())) continue;
      if (el.shadowRoot) walk(el.shadowRoot, depth);
      if (el.tagName === 'IFRAME') { lines.push('  '.repeat(depth) + '[iframe] ' + clip(el.src, 100)); continue; }
      const pad = '  '.repeat(Math.min(depth, 8));
      if (el.matches(INTERACTIVE) && visible(el)) {
        const ref = 'e' + (++count);
        el.setAttribute('data-emjosh-ref', ref);
        const bits = [];
        if (el.tagName === 'A') bits.push('href=' + clip(el.href, 100));
        if (el.type && el.tagName === 'INPUT') bits.push('type=' + el.type);
        if ('value' in el && el.tagName !== 'BUTTON' && el.type !== 'password' && el.value) bits.push('value=' + JSON.stringify(clip(el.value, 60)));
        if (el.checked) bits.push('checked');
        if (el.disabled) bits.push('disabled');
        if (el.tagName === 'SELECT') bits.push('options=' + JSON.stringify([...el.options].slice(0, 12).map((o) => clip(o.text, 30))));
        lines.push(pad + '[' + ref + '] ' + roleOf(el) + ' ' + JSON.stringify(clip(nameOf(el), 80)) + (bits.length ? ' ' + bits.join(' ') : ''));
        continue;
      }
      if (/^H[1-6]$/.test(el.tagName) && visible(el)) {
        lines.push(pad + 'heading(' + el.tagName[1] + ') ' + JSON.stringify(clip(el.innerText, 120)));
        continue;
      }
      if (BLOCK_TEXT.has(el.tagName) && visible(el) && !el.querySelector(INTERACTIVE)) {
        const text = clip(el.innerText, 200);
        if (text) { lines.push(pad + text); continue; }
      }
      walk(el, depth + 1);
    }
  };
  walk(document.body || document.documentElement, 0);
  return JSON.stringify({ url: location.href, title: document.title, lines });
})()`;

/** Page script that scrolls the ref into view and returns its viewport centre, or null. */
export function agentLocateScript(ref: string): string {
  return `(() => {
    const el = document.querySelector('[data-emjosh-ref="${assertAgentRef(ref)}"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;
}

/** Page script that focuses the ref (selecting its text unless appending); returns whether it exists. */
export function agentFocusScript(ref: string, append: boolean): string {
  return `(() => {
    const el = document.querySelector('[data-emjosh-ref="${assertAgentRef(ref)}"]');
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (${append ? 'false' : 'true'}) {
      if (typeof el.select === 'function') el.select();
      else if (el.isContentEditable) document.execCommand('selectAll');
    } else if (typeof el.setSelectionRange === 'function' && 'value' in el) {
      el.setSelectionRange(el.value.length, el.value.length);
    }
    return true;
  })()`;
}

/** Page script that picks a <select> option by its label or value; returns the chosen label or null. */
export function agentSelectScript(ref: string, option: string): string {
  return `(() => {
    const el = document.querySelector('[data-emjosh-ref="${assertAgentRef(ref)}"]');
    if (!el || el.tagName !== 'SELECT') return null;
    const wanted = ${JSON.stringify(option)}.trim().toLowerCase();
    const match = [...el.options].find((o) => o.text.trim().toLowerCase() === wanted || o.value.toLowerCase() === wanted);
    if (!match) return null;
    el.value = match.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return match.text;
  })()`;
}

export function agentPageTextScript(): string {
  return `(document.body ? document.body.innerText : '')`;
}

export function formatAgentSnapshot(snapshot: {
  url: string;
  title: string;
  lines: string[];
}): string {
  const header = `Page: ${JSON.stringify(snapshot.title)} ${snapshot.url}`;
  const body = snapshot.lines.length ? snapshot.lines.join('\n') : '(no visible content)';
  return truncateAgentText(`${header}\n${body}`);
}
