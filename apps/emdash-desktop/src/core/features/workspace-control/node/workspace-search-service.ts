import { readFile } from 'node:fs/promises';
import type {
  WorkspaceAskResult,
  WorkspaceAskStatus,
  WorkspaceSearchResult,
} from '../api/workspace-search';
import type { ControlPullRequest, ControlWorkspace } from './workspace-control-service';
import {
  compareByActivity,
  parseSearchQuery,
  type SearchableWorkspace,
  searchWorkspaces,
} from './workspace-search';
import {
  ASK_SYSTEM_PROMPT,
  buildAskPrompt,
  findSnippets,
  parseAskResponse,
  type SearchSnippet,
  snippetTerms,
  termHits,
} from './workspace-search-agent';

/** A file holding (part of) a workspace's chat transcript. */
export type TranscriptFile = { workspaceId: string; path: string };

export type WorkspaceSearchDeps = {
  /** Every workspace, archived ones included, without pull requests. */
  listWorkspaces(): Promise<Omit<ControlWorkspace, 'pullRequest'>[]>;
  pullRequestForBranch(projectId: string, branch: string): Promise<ControlPullRequest | null>;
  initiativeNames(): Promise<Map<string, string>>;
  /** Every initiative feed message (all initiatives). */
  initiativeMessages(): Promise<{ fromTaskId: string | null; body: string }[]>;
  /** The branch a workspace's worktree has checked out; null when unknown. */
  actualBranch?(workspaceId: string): Promise<string | null>;
  transcriptFiles?(workspaceIds: string[]): Promise<TranscriptFile[]>;
  readTranscript?(path: string): Promise<Buffer | null>;
  /**
   * Runs a cheap model once, with no tools, and returns its reply text; aborting `signal` stops
   * it. Absent when no agent CLI is available.
   */
  runModel?(input: { system: string; prompt: string; signal?: AbortSignal }): Promise<string>;
};

/** Workspaces the agent sees, most recent first; enough for the prompt to stay small. */
const ASK_WORKSPACE_LIMIT = 300;
const ASK_TRANSCRIPTS = 12;
const ASK_FEED_SNIPPETS = 30;
const READ_CONCURRENCY = 4;
const MAX_RUNS = 20;

type AskRun = WorkspaceAskStatus & { controller: AbortController };

async function readTranscriptFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++]!);
    })
  );
}

/**
 * Finds the workspace the user means: instantly from metadata (names, branches, PRs, ids,
 * projects, initiatives), else by asking a cheap, tool-less model over that metadata plus feed
 * and transcript passages that mention the query. Read-only.
 */
export class WorkspaceSearchService {
  constructor(private readonly deps: WorkspaceSearchDeps) {}

  async search(query: string): Promise<WorkspaceSearchResult> {
    if (!query.trim()) return { query, hits: [], conclusive: false };
    const workspaces = await this.searchable();
    const mentions = await this.mentions(query, workspaces);
    return searchWorkspaces(query, workspaces, { mentions });
  }

  get canAsk(): boolean {
    return !!this.deps.runModel;
  }

  private readonly runs = new Map<string, AskRun>();

  /** Starts an agent run in the background; follow it with askStatus. */
  startAsk(query: string): string {
    if (!this.deps.runModel) {
      throw new Error('Asking an agent needs the Claude Code CLI (claude) installed.');
    }
    const run: AskRun = {
      runId: crypto.randomUUID(),
      query,
      startedAt: Date.now(),
      state: 'running',
      step: 'Starting…',
      completed: [],
      controller: new AbortController(),
    };
    this.runs.set(run.runId, run);
    // Finished runs are kept briefly for the last poll; the oldest go first.
    for (const [id, old] of this.runs) {
      if (this.runs.size <= MAX_RUNS) break;
      if (old.state !== 'running') this.runs.delete(id);
    }
    void this.ask(query, {
      signal: run.controller.signal,
      onStep: (step) => {
        if (run.state !== 'running') return;
        if (run.step !== 'Starting…') run.completed.push(run.step);
        run.step = step;
      },
    }).then(
      (result) => {
        if (run.state !== 'running') return;
        run.completed.push(run.step);
        run.step = 'Done';
        run.state = 'done';
        run.result = result;
      },
      (error: unknown) => {
        if (run.state !== 'running') return;
        run.state = run.controller.signal.aborted ? 'cancelled' : 'failed';
        run.error = error instanceof Error ? error.message : String(error);
      }
    );
    return run.runId;
  }

  askStatus(runId: string): WorkspaceAskStatus {
    const run = this.runs.get(runId);
    if (!run) throw new Error('That search is no longer running.');
    const { controller: _controller, ...status } = run;
    return { ...status, completed: [...run.completed] };
  }

  cancelAsk(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || run.state !== 'running') return;
    run.state = 'cancelled';
    run.step = 'Cancelled';
    run.controller.abort();
  }

  async ask(
    query: string,
    options: { signal?: AbortSignal; onStep?: (step: string) => void } = {}
  ): Promise<WorkspaceAskResult> {
    const runModel = this.deps.runModel;
    if (!runModel) throw new Error('Asking an agent needs the Claude Code CLI (claude) installed.');
    const { signal } = options;
    const step = (text: string) => {
      signal?.throwIfAborted();
      options.onStep?.(text);
    };
    step('Collecting candidate workspaces…');
    const workspaces = await this.searchable();
    const quick = searchWorkspaces(query, workspaces, {
      mentions: await this.mentions(query, workspaces),
      limit: 10,
    });
    const quickIds = new Set(quick.hits.map((hit) => hit.workspace.id));
    // Active, recently used workspaces first; archived ones last, so they only fill what's left.
    const shown = [
      ...workspaces.filter((workspace) => quickIds.has(workspace.id)),
      ...workspaces.filter((workspace) => !quickIds.has(workspace.id)).sort(compareByActivity),
    ].slice(0, ASK_WORKSPACE_LIMIT);
    const terms = snippetTerms(query);
    const label =
      terms.length > 0
        ? ` for ${terms
            .slice(0, 2)
            .map((t) => `'${t}'`)
            .join(', ')}`
        : '';
    step(`Searching initiative feeds${label}…`);
    const feed = await this.feedSnippets(terms);
    step(`Searching chat transcripts${label}…`);
    const chats = await this.transcriptSnippets(
      terms,
      shown.map((workspace) => workspace.id)
    );
    const prompt = [
      buildAskPrompt({ query, workspaces: shown, snippets: [...feed, ...chats] }),
      ...(quick.hits.length > 0
        ? [
            '',
            'Metadata matches from a quick search (may be incomplete or wrong):',
            ...quick.hits.map((hit) => `${hit.workspace.id} (${hit.reasons.join(', ')})`),
          ]
        : []),
    ].join('\n');
    step('Asking the model…');
    const reply = await runModel({ system: ASK_SYSTEM_PROMPT, prompt, signal });
    step('Reading the answer…');
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const parsed = parseAskResponse(reply, new Set(byId.keys()));
    return {
      query,
      answer: parsed.answer,
      workspaces: parsed.workspaces.map(({ id, why }) => {
        const { actualBranch: _actual, ...ref } = byId.get(id)!;
        return { ...ref, why };
      }),
    };
  }

  /** Workspaces with their initiative names, PRs, and checked-out branches. */
  private async searchable(): Promise<SearchableWorkspace[]> {
    const [rows, initiativeNames] = await Promise.all([
      this.deps.listWorkspaces(),
      this.deps.initiativeNames().catch(() => new Map<string, string>()),
    ]);
    return Promise.all(
      rows.map(async (row) => {
        const actualBranch = (await this.deps.actualBranch?.(row.id).catch(() => null)) ?? null;
        const pullRequest =
          (await this.pullRequest(row.projectId, row.branch)) ??
          (actualBranch && actualBranch !== row.branch
            ? await this.pullRequest(row.projectId, actualBranch)
            : null);
        return {
          id: row.id,
          name: row.name,
          projectId: row.projectId,
          projectName: row.projectName,
          initiativeId: row.initiativeId,
          initiativeName: row.initiativeId ? (initiativeNames.get(row.initiativeId) ?? null) : null,
          branch: row.branch,
          archived: row.archived,
          agentStatus: row.agentStatus,
          markedDone: row.markedDone ?? false,
          lastActivityAt: row.lastActivityAt,
          pullRequest,
          ...(actualBranch && actualBranch !== row.branch ? { actualBranch } : {}),
        };
      })
    );
  }

  private async pullRequest(projectId: string, branch: string | null) {
    if (!branch) return null;
    return this.deps.pullRequestForBranch(projectId, branch).catch(() => null);
  }

  /**
   * Workspaces whose chat mentions the PR/MR the query points at. Only for PR queries: a literal
   * search through every transcript is cheap for one URL, not for every keystroke of free text.
   */
  private async mentions(
    query: string,
    workspaces: readonly SearchableWorkspace[]
  ): Promise<Set<string>> {
    const parsed = parseSearchQuery(query);
    const found = new Set<string>();
    if (!parsed.pullRequest || !this.deps.transcriptFiles) return found;
    const literals = new Set<string>();
    const urlMatch = /https?:\/\/\S+/i.exec(query);
    if (urlMatch && parsed.url) {
      const path = parsed.url.replace(/^[^/]+\//, '');
      const original = urlMatch[0].replace(/^https?:\/\/[^/]+\//i, '');
      literals.add(path);
      literals.add(original.slice(0, path.length));
    } else {
      literals.add(`merge_requests/${parsed.pullRequest.number}`);
      literals.add(`pull/${parsed.pullRequest.number}`);
    }
    const needles = [...literals].map((literal) => Buffer.from(literal));
    const files = await this.deps.transcriptFiles(workspaces.map((workspace) => workspace.id));
    const read = this.deps.readTranscript ?? readTranscriptFile;
    await forEachLimited(files, READ_CONCURRENCY, async (file) => {
      if (found.has(file.workspaceId)) return;
      const content = await read(file.path);
      if (!content) return;
      // A bare number ("pull/12") also matches "pull/123"; the next byte must not be a digit.
      const hit = needles.some((needle) => {
        let at = content.indexOf(needle);
        while (at >= 0) {
          const next = content[at + needle.length];
          if (next === undefined || next < 0x30 || next > 0x39) return true;
          at = content.indexOf(needle, at + 1);
        }
        return false;
      });
      if (hit) found.add(file.workspaceId);
    });
    return found;
  }

  private async feedSnippets(terms: readonly string[]): Promise<SearchSnippet[]> {
    if (terms.length === 0) return [];
    const messages = await this.deps.initiativeMessages().catch(() => []);
    return messages
      .map((message) => ({ message, hits: termHits(message.body, terms) }))
      .filter(({ hits }) => hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, ASK_FEED_SNIPPETS)
      .flatMap(({ message }) =>
        findSnippets(message.body, terms, 1).map((text) => ({
          workspaceId: message.fromTaskId,
          source: 'feed' as const,
          text,
        }))
      );
  }

  private async transcriptSnippets(
    terms: readonly string[],
    workspaceIds: string[]
  ): Promise<SearchSnippet[]> {
    if (terms.length === 0 || !this.deps.transcriptFiles) return [];
    const files = await this.deps.transcriptFiles(workspaceIds);
    const read = this.deps.readTranscript ?? readTranscriptFile;
    // A workspace has several transcript files (conversations, caches); its best one counts.
    const best = new Map<string, { workspaceId: string; hits: number; snippets: string[] }>();
    await forEachLimited(files, READ_CONCURRENCY, async (file) => {
      const content = await read(file.path);
      if (!content) return;
      const text = content.toString('utf8');
      const hits = termHits(text, terms);
      if (hits <= (best.get(file.workspaceId)?.hits ?? 0)) return;
      best.set(file.workspaceId, {
        workspaceId: file.workspaceId,
        hits,
        snippets: findSnippets(text, terms),
      });
    });
    return [...best.values()]
      .sort((a, b) => b.hits - a.hits)
      .slice(0, ASK_TRANSCRIPTS)
      .flatMap(({ workspaceId, snippets }) =>
        snippets.map((text) => ({ workspaceId, source: 'chat' as const, text }))
      );
  }
}
