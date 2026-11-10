import { describe, expect, it } from 'vitest';
import { buildUiPerfReport, formatUiPerfReport, sourceBucket } from './ui-perf-report';

describe('UI perf report', () => {
  it('groups CPU self time by function and source, leaving out idle and the recorder', () => {
    const report = buildUiPerfReport({
      durationMs: 15_000,
      renderer: {
        inputLatencies: [10, 20, 30, 120],
        slowEvents: [
          { name: 'keydown', duration: 40 },
          { name: 'keydown', duration: 90 },
        ],
        frames: [16, 17, 50],
        longTasks: [60, 80],
        reactCommits: 12,
        reactRenders: [
          ['ChatRow', 300],
          ['Sidebar', 40],
        ],
      },
      profile: {
        nodes: [
          { id: 1, callFrame: { functionName: '(idle)', url: '', lineNumber: 0 } },
          {
            id: 2,
            callFrame: {
              functionName: 'commitRoot',
              url: 'file:///app/node_modules/.pnpm/react-dom@19/node_modules/react-dom/cjs/x.js',
              lineNumber: 9,
            },
          },
          {
            id: 3,
            callFrame: {
              functionName: 'uiPerfCountCommitRenders',
              url: 'app://renderer/assets/index.js',
              lineNumber: 0,
            },
          },
          {
            id: 4,
            callFrame: {
              functionName: 'renderRow',
              url: 'app://renderer/assets/index.js',
              lineNumber: 41,
            },
          },
        ],
        samples: [1, 2, 2, 3, 4],
        timeDeltas: [5000, 2000, 3000, 9000, 1500],
      },
    });

    expect(report.inputLatencyMs).toEqual({ keys: 4, p50: 30, p95: 120, max: 120 });
    expect(report.frameMs).toMatchObject({ frames: 3, janky: 1, max: 50 });
    expect(report.longTasks).toEqual({ count: 2, totalMs: 140, maxMs: 80 });
    expect(report.slowEvents).toEqual([{ name: 'keydown', count: 2, maxMs: 90 }]);
    expect(report.cpu.busyMs).toBe(6.5);
    expect(report.cpu.byPackage).toEqual([
      { name: 'react-dom', ms: 5 },
      { name: 'app', ms: 1.5 },
    ]);
    expect(report.cpu.topFunctions[0]).toEqual({
      name: 'commitRoot  node_modules/react-dom/cjs/x.js:10',
      ms: 5,
    });
    expect(formatUiPerfReport(report)).toContain('300  ChatRow');
  });

  it('attributes workspace packages and the engine', () => {
    expect(sourceBucket('file:///repo/packages/chat-ui/src/row.tsx', 'f')).toBe('@emdash/chat-ui');
    expect(sourceBucket('', '(garbage collector)')).toBe('(garbage collector)');
    expect(sourceBucket('', 'Function.prototype.apply')).toBe('(native)');
  });
});
