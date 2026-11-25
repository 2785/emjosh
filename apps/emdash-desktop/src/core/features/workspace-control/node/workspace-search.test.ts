import { describe, expect, it } from 'vitest';
import {
  normalizePullRequestUrl,
  parsePullRequestUrl,
  parseSearchQuery,
  searchWorkspaces,
  type SearchableWorkspace,
} from './workspace-search';

function ws(overrides: Partial<SearchableWorkspace> & { id: string }): SearchableWorkspace {
  return {
    name: overrides.id,
    projectId: 'p1',
    projectName: 'preprocessor',
    initiativeId: null,
    initiativeName: null,
    branch: null,
    archived: false,
    agentStatus: null,
    markedDone: false,
    lastActivityAt: null,
    pullRequest: null,
    ...overrides,
  };
}

const MR_URL = 'https://gitlab.com/synctera/preprocessor/-/merge_requests/5799';

const workspaces = [
  ws({
    id: 'a1b2c3d4-0000-0000-0000-000000000001',
    name: 'Fix self-partner recon search scoping',
    branch: 'emdash/fix-self-partner-recon-search-scoping-7bqty',
    pullRequest: { url: MR_URL, number: 5799, title: 'Scope recon search', state: 'open' },
  }),
  ws({
    id: 'a1b2c3d4-0000-0000-0000-000000000002',
    name: 'Other repo MR',
    projectName: 'ledger',
    pullRequest: {
      url: 'https://gitlab.com/synctera/ledger/-/merge_requests/5799',
      number: 5799,
      title: 'Unrelated',
      state: 'merged',
    },
  }),
  ws({
    id: 'a1b2c3d4-0000-0000-0000-000000000003',
    name: 'Sweeps hardening lead',
    initiativeId: 'init-1',
    initiativeName: 'Sweeps hardening',
    archived: true,
    branch: 'emdash/sweeps-lead-9g0xy',
    actualBranch: 'emdash/krak-123-sweeps',
  }),
];

const ids = (query: string, options?: Parameters<typeof searchWorkspaces>[2]) =>
  searchWorkspaces(query, workspaces, options).hits.map((hit) => hit.workspace.id.slice(-1));

describe('pull request URLs', () => {
  it('normalizes suffixes, query, case and trailing slash', () => {
    expect(normalizePullRequestUrl(`${MR_URL}/diffs?tab=1#note_2`)).toBe(
      'gitlab.com/synctera/preprocessor/-/merge_requests/5799'
    );
    expect(normalizePullRequestUrl('https://GitHub.com/Org/Repo/pull/12/')).toBe(
      'github.com/org/repo/pull/12'
    );
    expect(normalizePullRequestUrl('not a url')).toBeNull();
  });

  it('extracts repository path and number', () => {
    expect(parsePullRequestUrl(MR_URL)).toEqual({
      repoPath: 'synctera/preprocessor',
      number: 5799,
    });
    expect(parsePullRequestUrl('https://github.com/org/repo/pull/12')).toEqual({
      repoPath: 'org/repo',
      number: 12,
    });
  });
});

describe('parseSearchQuery', () => {
  it('recognises PR numbers in common spellings', () => {
    for (const text of ['5799', '!5799', '#5799', 'MR 5799', 'pr #5799']) {
      expect(parseSearchQuery(text).pullRequest).toEqual({ number: 5799 });
    }
    expect(parseSearchQuery('fix 5799 things').pullRequest).toBeNull();
  });

  it('extracts tickets and drops stopwords', () => {
    const query = parseSearchQuery('the one fixing KRAK-123 recon');
    expect(query.tickets).toEqual(['krak-123']);
    expect(query.terms).toContain('recon');
    expect(query.terms).not.toContain('the');
  });
});

describe('searchWorkspaces', () => {
  it('finds the workspace by PR URL, and only that repository', () => {
    const result = searchWorkspaces(MR_URL, workspaces);
    expect(result.hits.map((hit) => hit.workspace.id.slice(-1))).toEqual(['1']);
    expect(result.hits[0]!.reasons).toContain('MR !5799');
    expect(result.conclusive).toBe(true);
  });

  it('matches a URL with a /diffs suffix', () => {
    expect(ids(`${MR_URL}/diffs`)).toEqual(['1']);
  });

  it('matches a bare number across repositories, inconclusively', () => {
    const result = searchWorkspaces('!5799', workspaces);
    expect(result.hits.map((hit) => hit.workspace.id.slice(-1)).sort()).toEqual(['1', '2']);
    expect(result.conclusive).toBe(false);
  });

  it('matches stored and checked-out branches, archived ones included', () => {
    expect(ids('emdash/sweeps-lead-9g0xy')).toEqual(['3']);
    const byActual = searchWorkspaces('emdash/krak-123-sweeps', workspaces);
    expect(byActual.hits[0]!.workspace.archived).toBe(true);
    expect(byActual.hits[0]!.workspace.id.endsWith('3')).toBe(true);
  });

  it('matches full ids and unique id prefixes', () => {
    expect(ids('a1b2c3d4-0000-0000-0000-000000000002')).toEqual(['2']);
    expect(ids('a1b2c3d4-0000-0000-0000-00000000000')).toHaveLength(3);
  });

  it('matches ticket ids in branches', () => {
    expect(ids('KRAK-123')).toEqual(['3']);
  });

  it('matches descriptions by words in name, branch and PR title', () => {
    expect(ids('the one fixing self-partner recon search')[0]).toBe('1');
    expect(ids('scope recon')[0]).toBe('1');
  });

  it('matches initiative and project names', () => {
    expect(ids('sweeps hardening')[0]).toBe('3');
    expect(ids('ledger')).toEqual(['2']);
  });

  it('adds workspaces whose chat mentions the PR as a weaker hit', () => {
    const result = searchWorkspaces(MR_URL, workspaces, {
      mentions: new Set([workspaces[2]!.id]),
    });
    expect(result.hits.map((hit) => hit.workspace.id.slice(-1))).toEqual(['1', '3']);
    expect(result.hits[1]!.reasons).toEqual(['mentioned in its chat']);
    expect(result.conclusive).toBe(true);
  });

  it('returns nothing for unrelated text', () => {
    expect(ids('quantum banana')).toEqual([]);
  });

  it('ranks active workspaces ahead of archived ones on ties', () => {
    const tied = [
      ws({ id: 'x1', name: 'recon', archived: true, lastActivityAt: '2026-11-01' }),
      ws({ id: 'x2', name: 'recon', lastActivityAt: '2026-01-01' }),
    ];
    expect(searchWorkspaces('recon', tied).hits.map((h) => h.workspace.id)).toEqual(['x2', 'x1']);
  });
});
