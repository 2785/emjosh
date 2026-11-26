import { describe, expect, it } from 'vitest';
import {
  mobileTaskSections,
  parseActivityTime,
  shortAgo,
  type MobileTaskEntry,
} from './mobile-sections';

const entry = (taskId: string, overrides: Partial<MobileTaskEntry> = {}): MobileTaskEntry => ({
  projectId: 'p',
  projectName: 'api',
  taskId,
  name: taskId,
  status: null,
  activityAt: '2026-11-01T00:00:00.000Z',
  initiativeName: null,
  pullRequest: null,
  ...overrides,
});

describe('mobileTaskSections', () => {
  it('puts what needs the user first, then what runs, then the rest, newest first', () => {
    const sections = mobileTaskSections([
      entry('old', { activityAt: '2026-10-01T00:00:00.000Z' }),
      entry('new', { activityAt: '2026-11-02T00:00:00.000Z' }),
      entry('done', { status: 'completed' }),
      entry('waiting', { status: 'awaiting-input' }),
      entry('failed', { status: 'error' }),
      entry('busy', { status: 'working' }),
      entry('background', { status: 'background', activityAt: '2026-10-15T00:00:00.000Z' }),
      entry('idle', { status: 'idle' }),
    ]);
    expect(sections.attention.map((e) => e.taskId)).toEqual(['waiting', 'failed', 'done']);
    expect(sections.working.map((e) => e.taskId)).toEqual(['busy', 'background']);
    expect(sections.recent.map((e) => e.taskId)).toEqual(['new', 'idle', 'old']);
  });

  it('filters by workspace, project or initiative name', () => {
    const sections = mobileTaskSections(
      [
        entry('a', { name: 'Fix login' }),
        entry('b', { projectName: 'web' }),
        entry('c', { initiativeName: 'Accounts v2' }),
      ],
      'accounts'
    );
    expect(sections.recent.map((e) => e.taskId)).toEqual(['c']);
  });
});

describe('shortAgo', () => {
  it('reads compactly', () => {
    const now = Date.parse('2026-11-10T12:00:00.000Z');
    expect(shortAgo('2026-11-10T11:59:40.000Z', now)).toBe('now');
    expect(shortAgo('2026-11-10T11:55:00.000Z', now)).toBe('5m');
    expect(shortAgo('2026-11-10T09:00:00.000Z', now)).toBe('3h');
    expect(shortAgo('2026-11-08T12:00:00.000Z', now)).toBe('2d');
    expect(shortAgo(undefined, now)).toBe('');
  });
});

describe('database timestamps without a zone', () => {
  it('reads "YYYY-MM-DD HH:MM:SS" as UTC, whatever the phone time zone is', () => {
    expect(parseActivityTime('2026-11-10 08:00:00')).toBe(Date.parse('2026-11-10T08:00:00.000Z'));
    expect(parseActivityTime('2026-11-10T08:00:00.000Z')).toBe(
      Date.parse('2026-11-10T08:00:00.000Z')
    );
    expect(parseActivityTime(undefined)).toBeNaN();
  });

  it('shows the real age instead of "now" for a recent database timestamp', () => {
    const now = Date.parse('2026-11-10T12:00:00.000Z');
    expect(shortAgo('2026-11-10 08:00:00', now)).toBe('4h');
  });

  it('orders database timestamps and ISO times by the moment they describe', () => {
    const sections = mobileTaskSections([
      entry('iso-early', { activityAt: '2026-11-10T08:00:00.000Z' }),
      entry('db-late', { activityAt: '2026-11-10 20:00:00' }),
      entry('iso-late', { activityAt: '2026-11-10T21:00:00.000Z' }),
      entry('db-early', { activityAt: '2026-11-10 07:00:00' }),
    ]);
    expect(sections.recent.map((e) => e.taskId)).toEqual([
      'iso-late',
      'db-late',
      'iso-early',
      'db-early',
    ]);
  });
});
