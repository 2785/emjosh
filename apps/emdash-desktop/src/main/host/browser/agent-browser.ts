import { BrowserWindow, type WebContents } from 'electron';
import {
  AGENT_BROWSER_IDLE_MS,
  AGENT_BROWSER_MAX_PAGES,
  AGENT_BROWSER_PROFILE_ID,
  AGENT_SNAPSHOT_SCRIPT,
  agentFocusScript,
  agentKeyEvent,
  agentLocateScript,
  agentPageTextScript,
  agentSelectScript,
  formatAgentSnapshot,
  normalizeAgentUrl,
  truncateAgentText,
  type AgentBrowserPort,
  type AgentConsoleEntry,
  type AgentPageAction,
  type AgentPageInfo,
} from '@core/features/browser/api/agent-browser';
import { browserProfilePartition } from '@core/primitives/browser/api';
import { log } from '@main/lib/logger';
import { configureBrowserProfileSession } from './browser-profile-session';

const PAGE_WIDTH = 1280;
const PAGE_HEIGHT = 800;
const MAX_CONSOLE_ENTRIES = 200;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const MAX_WAIT_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 30_000;

type Page = {
  pageId: string;
  scope: string;
  window: BrowserWindow;
  console: AgentConsoleEntry[];
  lastUsed: number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Browser pages for agents: one hidden window per page, in the dedicated agent profile, driven
 * through the Chrome DevTools protocol. Pages belong to the workspace that opened them, and
 * outlive whichever workspace is on screen. `show` reveals a page's window to the user.
 */
export class AgentBrowser implements AgentBrowserPort {
  private readonly pagesByScope = new Map<string, Page[]>();
  private sequence = 0;
  private readonly sweeper = setInterval(() => this.closeIdlePages(), 60_000);

  constructor() {
    this.sweeper.unref();
  }

  async open(scope: string, input: { url: string; show?: boolean }): Promise<AgentPageInfo> {
    const url = normalizeAgentUrl(input.url);
    const existing = this.pagesByScope.get(scope) ?? [];
    if (existing.length >= AGENT_BROWSER_MAX_PAGES) {
      throw new Error(
        `This workspace already has ${AGENT_BROWSER_MAX_PAGES} browser pages open. Close one with browser_close first.`
      );
    }
    const page = this.createPage(scope);
    await this.load(page, url);
    if (input.show) page.window.showInactive();
    return this.info(page);
  }

  pages(scope: string): AgentPageInfo[] {
    return (this.pagesByScope.get(scope) ?? []).map((page) => this.info(page));
  }

  async navigate(
    scope: string,
    pageId: string | undefined,
    input: { url?: string; action?: 'back' | 'forward' | 'reload' }
  ): Promise<AgentPageInfo> {
    const page = this.resolve(scope, pageId);
    const contents = page.window.webContents;
    if (input.url) {
      await this.load(page, normalizeAgentUrl(input.url));
    } else if (input.action === 'back' && contents.navigationHistory.canGoBack()) {
      contents.navigationHistory.goBack();
      await this.settle(page);
    } else if (input.action === 'forward' && contents.navigationHistory.canGoForward()) {
      contents.navigationHistory.goForward();
      await this.settle(page);
    } else if (input.action === 'reload') {
      contents.reload();
      await this.settle(page);
    } else {
      throw new Error(
        'Pass a url, or an action that is possible from this page (back, forward, reload).'
      );
    }
    return this.info(page);
  }

  async snapshot(scope: string, pageId: string | undefined) {
    const page = this.resolve(scope, pageId);
    const raw = await this.evaluate<string>(page, AGENT_SNAPSHOT_SCRIPT);
    const parsed = JSON.parse(raw) as { url: string; title: string; lines: string[] };
    return { page: this.info(page), text: formatAgentSnapshot(parsed) };
  }

  async screenshot(scope: string, pageId: string | undefined, input: { fullPage?: boolean }) {
    const page = this.resolve(scope, pageId);
    const result = await this.send<{ data: string }>(page, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: input.fullPage === true,
    });
    return { page: this.info(page), pngBase64: result.data };
  }

  async act(scope: string, pageId: string | undefined, action: AgentPageAction) {
    const page = this.resolve(scope, pageId);
    let detail: string | undefined;
    switch (action.type) {
      case 'click':
        await this.click(page, action.ref, action.doubleClick ? 2 : 1);
        await sleep(150);
        break;
      case 'type':
        await this.typeText(page, action);
        break;
      case 'select': {
        const chosen = await this.evaluate<string | null>(
          page,
          agentSelectScript(action.ref, action.option)
        );
        if (chosen === null)
          throw new Error(`No option "${action.option}" in ${action.ref}, or it isn't a select.`);
        detail = `Selected "${chosen}".`;
        break;
      }
      case 'press':
        await this.pressKey(page, action.key);
        await sleep(100);
        break;
      case 'scroll':
        await this.evaluate(
          page,
          action.direction === 'top'
            ? 'window.scrollTo(0, 0)'
            : action.direction === 'bottom'
              ? 'window.scrollTo(0, document.documentElement.scrollHeight)'
              : `window.scrollBy(0, ${action.direction === 'down' ? '' : '-'}Math.round(window.innerHeight * 0.8))`
        );
        break;
      case 'wait':
        detail = await this.wait(page, action);
        break;
    }
    await this.settle(page, 2_000);
    return { page: this.info(page), detail };
  }

  async console(scope: string, pageId: string | undefined, input: { clear?: boolean }) {
    const page = this.resolve(scope, pageId);
    const entries = [...page.console];
    if (input.clear) page.console.length = 0;
    return { page: this.info(page), entries };
  }

  async show(scope: string, pageId: string | undefined): Promise<AgentPageInfo> {
    const page = this.resolve(scope, pageId);
    page.window.show();
    return this.info(page);
  }

  async close(scope: string, pageId: string | undefined) {
    const page = this.resolve(scope, pageId);
    page.window.destroy();
    return { closed: page.pageId };
  }

  /** Closes every page, such as when the app quits or a workspace is archived. */
  closeScope(scope: string): void {
    for (const page of [...(this.pagesByScope.get(scope) ?? [])]) page.window.destroy();
  }

  dispose(): void {
    clearInterval(this.sweeper);
    for (const scope of [...this.pagesByScope.keys()]) this.closeScope(scope);
  }

  private createPage(scope: string): Page {
    const partition = browserProfilePartition(AGENT_BROWSER_PROFILE_ID);
    configureBrowserProfileSession(partition);
    const window = new BrowserWindow({
      show: false,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      title: 'Agent browser',
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
      },
    });
    const page: Page = {
      pageId: `p${++this.sequence}`,
      scope,
      window,
      console: [],
      lastUsed: Date.now(),
    };
    const contents = window.webContents;

    // Popups open as another page of the same workspace, in this same profile.
    contents.setWindowOpenHandler(({ url }) => {
      void this.open(scope, { url }).catch((error: unknown) =>
        log.warn('agent-browser: popup blocked', { url, error: String(error) })
      );
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      try {
        normalizeAgentUrl(url);
      } catch {
        event.preventDefault();
      }
    });
    contents.session.on('will-download', (event) => event.preventDefault());

    contents.debugger.attach('1.3');
    contents.debugger.on('message', (_event, method, params) =>
      this.onProtocolEvent(page, method, params)
    );
    for (const domain of ['Runtime.enable', 'Page.enable', 'Network.enable', 'Log.enable']) {
      void contents.debugger.sendCommand(domain).catch(() => undefined);
    }

    window.on('closed', () => {
      const remaining = (this.pagesByScope.get(scope) ?? []).filter(
        (candidate) => candidate !== page
      );
      if (remaining.length) this.pagesByScope.set(scope, remaining);
      else this.pagesByScope.delete(scope);
    });
    this.pagesByScope.set(scope, [...(this.pagesByScope.get(scope) ?? []), page]);
    return page;
  }

  private onProtocolEvent(page: Page, method: string, params: unknown): void {
    const p = params as Record<string, unknown>;
    const push = (level: string, text: string) => {
      page.console.push({ level, text: truncateAgentText(text, 2_000) });
      if (page.console.length > MAX_CONSOLE_ENTRIES) page.console.shift();
    };
    if (method === 'Runtime.consoleAPICalled') {
      const args = (p.args as { value?: unknown; description?: string }[] | undefined) ?? [];
      push(
        String(p.type ?? 'log'),
        args
          .map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? '')))
          .join(' ')
      );
    } else if (method === 'Runtime.exceptionThrown') {
      const details = p.exceptionDetails as
        | { text?: string; exception?: { description?: string } }
        | undefined;
      push('error', details?.exception?.description ?? details?.text ?? 'Uncaught exception');
    } else if (method === 'Log.entryAdded') {
      const entry = p.entry as { level?: string; text?: string; url?: string } | undefined;
      if (entry?.level === 'error' || entry?.level === 'warning') {
        push(entry.level, `${entry.text ?? ''} ${entry.url ?? ''}`.trim());
      }
    } else if (method === 'Network.responseReceived') {
      const response = p.response as { status?: number; url?: string } | undefined;
      if (response?.status && response.status >= 400)
        push('network', `${response.status} ${response.url ?? ''}`);
    } else if (method === 'Network.loadingFailed' && p.canceled !== true) {
      push('network', `request failed: ${String(p.errorText ?? 'unknown error')}`);
    }
  }

  private resolve(scope: string, pageId: string | undefined): Page {
    const pages = this.pagesByScope.get(scope) ?? [];
    const page = pageId
      ? pages.find((candidate) => candidate.pageId === pageId)
      : [...pages].sort((a, b) => b.lastUsed - a.lastUsed)[0];
    if (!page || page.window.isDestroyed()) {
      throw new Error(
        pageId
          ? `No browser page "${pageId}" in this workspace. browser_pages lists the open ones.`
          : 'No browser page is open in this workspace. Open one with browser_open.'
      );
    }
    page.lastUsed = Date.now();
    return page;
  }

  private info(page: Page): AgentPageInfo {
    const contents = page.window.webContents;
    return {
      pageId: page.pageId,
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
    };
  }

  private async load(page: Page, url: string): Promise<void> {
    const contents = page.window.webContents;
    try {
      await Promise.race([
        contents.loadURL(url),
        sleep(LOAD_TIMEOUT_MS).then(() => {
          throw new Error(`Timed out loading ${url}.`);
        }),
      ]);
    } catch (error) {
      // Navigations the page itself replaces (redirects) reject with ERR_ABORTED; the page is fine.
      if (!/ERR_ABORTED/.test(String(error))) throw error;
    }
    await this.settle(page, 3_000);
  }

  /** Waits for the page to stop loading, up to `limitMs`. */
  private async settle(page: Page, limitMs = LOAD_TIMEOUT_MS): Promise<void> {
    const contents = page.window.webContents;
    const deadline = Date.now() + limitMs;
    while (!contents.isDestroyed() && contents.isLoading() && Date.now() < deadline)
      await sleep(100);
  }

  private send<T = unknown>(page: Page, method: string, params?: object): Promise<T> {
    return this.debuggerOf(page).sendCommand(method, params) as Promise<T>;
  }

  private debuggerOf(page: Page): WebContents['debugger'] {
    return page.window.webContents.debugger;
  }

  private async evaluate<T = unknown>(page: Page, expression: string): Promise<T> {
    const result = await this.send<{
      result: { value?: T };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>(page, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'Script failed'
      );
    }
    return result.result.value as T;
  }

  private async click(page: Page, ref: string, clickCount: number): Promise<void> {
    const point = await this.evaluate<{ x: number; y: number } | null>(
      page,
      agentLocateScript(ref)
    );
    if (!point) throw new Error(`Element ${ref} is gone. Take a new browser_snapshot.`);
    const base = { x: point.x, y: point.y, button: 'left', clickCount };
    await this.send(page, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
    await this.send(page, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await this.send(page, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  }

  private async typeText(
    page: Page,
    action: Extract<AgentPageAction, { type: 'type' }>
  ): Promise<void> {
    const found = await this.evaluate<boolean>(
      page,
      agentFocusScript(action.ref, action.append === true)
    );
    if (!found) throw new Error(`Element ${action.ref} is gone. Take a new browser_snapshot.`);
    await this.send(page, 'Input.insertText', { text: action.text });
    if (action.submit) await this.pressKey(page, 'Enter');
  }

  private async pressKey(page: Page, name: string): Promise<void> {
    const event = agentKeyEvent(name);
    await this.send(page, 'Input.dispatchKeyEvent', {
      type: event.text ? 'keyDown' : 'rawKeyDown',
      ...event,
    });
    await this.send(page, 'Input.dispatchKeyEvent', { type: 'keyUp', ...event, text: undefined });
  }

  private async wait(
    page: Page,
    action: Extract<AgentPageAction, { type: 'wait' }>
  ): Promise<string> {
    if (action.text === undefined && action.textGone === undefined) {
      await sleep(Math.min(action.ms ?? 1_000, MAX_WAIT_TIMEOUT_MS));
      return 'Waited.';
    }
    const timeout = Math.min(action.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const text = await this.evaluate<string>(page, agentPageTextScript()).catch(() => '');
      if (action.text !== undefined && text.includes(action.text)) return `Found "${action.text}".`;
      if (action.textGone !== undefined && !text.includes(action.textGone)) {
        return `"${action.textGone}" is gone.`;
      }
      await sleep(250);
    }
    throw new Error(`Timed out after ${timeout} ms waiting for ${action.text ?? action.textGone}.`);
  }

  private closeIdlePages(): void {
    const cutoff = Date.now() - AGENT_BROWSER_IDLE_MS;
    for (const pages of this.pagesByScope.values()) {
      for (const page of [...pages]) {
        if (page.lastUsed < cutoff && !page.window.isVisible()) page.window.destroy();
      }
    }
  }
}
