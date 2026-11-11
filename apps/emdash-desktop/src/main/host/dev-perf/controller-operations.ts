import { mkdir, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { app, contentTracing } from 'electron';
import type { DevPerfTraceError } from '@core/features/dev-perf/api/contract';
import {
  buildUiPerfReport,
  formatUiPerfReport,
  type CpuProfile,
  type UiPerfRendererRecording,
} from '@core/features/dev-perf/api/ui-perf-report';
import type { DevPerfOperations } from '@core/features/dev-perf/node/wire-controller';
import { getBootReport } from '@main/bootstrap/core/boot-report';
import type { DesktopRuntimes } from '@main/gateway/desktop-runtimes';
import { getMainWindow } from '@main/host/window';
import { log } from '@main/lib/logger';

let tracingInFlight = false;

/**
 * Record a contentTracing trace for `durationMs` and write it under
 * `<userData>/traces/`. A capture already running is an expected failure —
 * traces are whole-app recordings, so overlapping captures make no sense.
 */
async function captureTrace(durationMs: number): Promise<Result<string, DevPerfTraceError>> {
  if (tracingInFlight) return err({ type: 'trace_in_progress' as const });
  tracingInFlight = true;
  try {
    const dir = join(app.getPath('userData'), 'traces');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `emdash-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await contentTracing.startRecording({
      included_categories: ['*'],
      excluded_categories: ['*-details'],
    });
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const path = await contentTracing.stopRecording(file);
    log.info('dev-perf: trace captured', { path, durationMs });
    return ok(path);
  } finally {
    tracingInFlight = false;
  }
}

type UiProfileError = { type: 'trace_in_progress' | 'no_window' | 'debugger_busy' };

/**
 * Profiles the main window's renderer for `durationMs`: a V8 CPU profile through the window's
 * debugger, plus what the renderer recorder collects (src/renderer/perf/ui-perf-recorder.ts).
 * Writes `profile.cpuprofile` (open in DevTools → Performance), `report.json` and `report.txt`
 * under `<userData>/perf/<timestamp>/`.
 */
async function recordUiProfile(
  durationMs: number
): Promise<Result<{ reportPath: string; summary: string }, UiProfileError>> {
  if (tracingInFlight) return err({ type: 'trace_in_progress' as const });
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return err({ type: 'no_window' as const });
  const { webContents } = window;
  // One debugger client per page: open developer tools would hold it.
  if (webContents.debugger.isAttached() || webContents.isDevToolsOpened()) {
    return err({ type: 'debugger_busy' as const });
  }
  tracingInFlight = true;
  try {
    // The main process too: it runs the window's UI thread, so its busy time delays input.
    const main = new Session();
    main.connect();
    await main.post('Profiler.enable');
    await main.post('Profiler.setSamplingInterval', { interval: 500 });
    await main.post('Profiler.start');
    webContents.debugger.attach('1.3');
    await webContents.debugger.sendCommand('Profiler.enable');
    await webContents.debugger.sendCommand('Profiler.setSamplingInterval', { interval: 200 });
    await webContents.debugger.sendCommand('Profiler.start');
    await webContents.executeJavaScript('window.__emjoshUiPerf?.start()');
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const renderer = (await webContents.executeJavaScript(
      'window.__emjoshUiPerf?.stop() ?? null'
    )) as UiPerfRendererRecording | null;
    const { profile } = (await webContents.debugger.sendCommand('Profiler.stop')) as {
      profile: CpuProfile;
    };
    const { profile: mainProfile } = (await main.post('Profiler.stop')) as unknown as {
      profile: CpuProfile;
    };
    main.disconnect();

    const dir = join(
      app.getPath('userData'),
      'perf',
      new Date().toISOString().replace(/[:.]/g, '-')
    );
    await mkdir(dir, { recursive: true });
    const rendererMarks = ((await webContents.executeJavaScript(
      'window.__emjoshBootMarks ?? []'
    )) ?? []) as { mark: string; ms: number }[];
    const report = buildUiPerfReport({
      durationMs,
      renderer,
      profile,
      mainProfile,
      boot: { ...getBootReport(), rendererMarks },
    });
    const summary = formatUiPerfReport(report);
    const reportPath = join(dir, 'report.txt');
    await Promise.all([
      writeFile(join(dir, 'profile.cpuprofile'), JSON.stringify(profile)),
      writeFile(join(dir, 'main.cpuprofile'), JSON.stringify(mainProfile)),
      writeFile(join(dir, 'report.json'), JSON.stringify({ report, renderer }, null, 2)),
      writeFile(reportPath, summary),
    ]);
    log.info('dev-perf: UI profile recorded', { dir });
    return ok({ reportPath, summary });
  } finally {
    if (webContents.debugger.isAttached()) webContents.debugger.detach();
    tracingInFlight = false;
  }
}

export function createDevPerfOperations(runtimes: DesktopRuntimes): DevPerfOperations {
  return {
    captureTrace,
    recordUiProfile,
    setWorkerSpawnLogging: (enabled) => runtimes.setWorkerSpawnLogging(enabled),
  };
}
