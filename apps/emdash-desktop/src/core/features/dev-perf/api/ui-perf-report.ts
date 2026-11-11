/** What the renderer records during "Record UI Performance Profile". Durations in ms. */
export type UiPerfRendererRecording = {
  /** keydown → the next frame, per key. */
  inputLatencies: number[];
  /** Event Timing entries of at least 16 ms. */
  slowEvents: { name: string; duration: number }[];
  /** Time between consecutive animation frames. */
  frames: number[];
  longTasks: number[];
  reactCommits: number;
  /** Components by how often they rendered, most first. */
  reactRenders: [string, number][];
};

/** The subset of a V8 `.cpuprofile` the report reads. */
export type CpuProfile = {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
  }[];
  samples: number[];
  timeDeltas: number[];
};

export type UiPerfReport = {
  durationMs: number;
  inputLatencyMs: { keys: number; p50: number; p95: number; max: number } | null;
  frameMs: { frames: number; p50: number; p95: number; max: number; janky: number };
  longTasks: { count: number; totalMs: number; maxMs: number };
  slowEvents: { name: string; count: number; maxMs: number }[];
  react: { commits: number; topRenders: [string, number][] } | null;
  cpu: CpuSummary;
  /**
   * The main process: it also runs the window's UI thread, so while it is busy, input waits
   * before it reaches the renderer.
   */
  mainCpu: CpuSummary | null;
  /** How this launch went, in ms since the process (main) or page (renderer) started. */
  boot: UiPerfBoot | null;
};

export type UiPerfBoot = {
  mainEnteredMs?: number;
  windowVisibleMs?: number;
  usableWorkspaceMs?: number;
  /** Main-process boot phases by duration. */
  phases: Record<string, number>;
  /** Renderer boot marks, ms since the page started loading. */
  rendererMarks: { mark: string; ms: number }[];
};

export type CpuSummary = {
  busyMs: number;
  byPackage: { name: string; ms: number }[];
  topFunctions: { name: string; ms: number }[];
};

const round = (n: number) => Math.round(n * 10) / 10;

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/** Where a function comes from: a package name, a workspace package, the app, or the engine. */
export function sourceBucket(url: string, functionName: string): string {
  if (!url) return functionName.startsWith('(') ? functionName : '(native)';
  const dependency = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(
    url
  );
  if (dependency) return dependency[1]!;
  const workspace = /\/packages\/([^/]+)\//.exec(url);
  if (workspace) return `@emdash/${workspace[1]}`;
  return 'app';
}

/** Self time per function and per source, without idle time and the recorder's own work. */
export function summarizeCpuProfile(profile: CpuProfile): CpuSummary {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfMicros = new Map<number, number>();
  profile.samples.forEach((id, index) => {
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0));
  });
  const functions = new Map<string, number>();
  const buckets = new Map<string, number>();
  let busy = 0;
  for (const [id, micros] of selfMicros) {
    const { functionName, url, lineNumber } = nodes.get(id)!.callFrame;
    const name = functionName || '(anonymous)';
    if (name === '(idle)' || name === '(program)' || name.startsWith('uiPerf')) continue;
    busy += micros;
    const file = url.replace(/^.*\/(node_modules|assets|src)\//, '$1/');
    const key = file ? `${name}  ${file}:${lineNumber + 1}` : name;
    functions.set(key, (functions.get(key) ?? 0) + micros);
    const bucket = sourceBucket(url, name);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + micros);
  }
  const top = (map: Map<string, number>, n: number) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, micros]) => ({ name, ms: round(micros / 1000) }));
  return {
    busyMs: round(busy / 1000),
    byPackage: top(buckets, 12),
    topFunctions: top(functions, 30),
  };
}

export function buildUiPerfReport(input: {
  durationMs: number;
  renderer: UiPerfRendererRecording | null;
  profile: CpuProfile;
  mainProfile?: CpuProfile | null;
  boot?: UiPerfBoot | null;
}): UiPerfReport {
  const r = input.renderer;
  const latencies = r?.inputLatencies ?? [];
  const frames = r?.frames ?? [];
  const longTasks = r?.longTasks ?? [];
  const events = new Map<string, number[]>();
  for (const event of r?.slowEvents ?? []) {
    events.set(event.name, [...(events.get(event.name) ?? []), event.duration]);
  }
  return {
    durationMs: input.durationMs,
    inputLatencyMs:
      latencies.length > 0
        ? {
            keys: latencies.length,
            p50: round(percentile(latencies, 50)),
            p95: round(percentile(latencies, 95)),
            max: round(Math.max(...latencies)),
          }
        : null,
    frameMs: {
      frames: frames.length,
      p50: round(percentile(frames, 50)),
      p95: round(percentile(frames, 95)),
      max: round(Math.max(0, ...frames)),
      // Longer than two refresh intervals at 60 Hz.
      janky: frames.filter((frame) => frame > 33.4).length,
    },
    longTasks: {
      count: longTasks.length,
      totalMs: round(longTasks.reduce((sum, task) => sum + task, 0)),
      maxMs: round(Math.max(0, ...longTasks)),
    },
    slowEvents: [...events.entries()]
      .map(([name, durations]) => ({
        name,
        count: durations.length,
        maxMs: round(Math.max(...durations)),
      }))
      .sort((a, b) => b.count - a.count),
    react: r ? { commits: r.reactCommits, topRenders: r.reactRenders.slice(0, 25) } : null,
    cpu: summarizeCpuProfile(input.profile),
    mainCpu: input.mainProfile ? summarizeCpuProfile(input.mainProfile) : null,
    boot: input.boot ?? null,
  };
}

export function formatUiPerfReport(report: UiPerfReport): string {
  const lines = [`UI performance profile, ${report.durationMs / 1000} s`, ''];
  if (report.inputLatencyMs) {
    const l = report.inputLatencyMs;
    lines.push(
      `keydown → frame   p50 ${l.p50} ms  p95 ${l.p95} ms  max ${l.max} ms  (${l.keys} keys)`
    );
  }
  const f = report.frameMs;
  lines.push(
    `frames            p50 ${f.p50} ms  p95 ${f.p95} ms  max ${f.max} ms  janky ${f.janky}/${f.frames}`,
    `long tasks        ${report.longTasks.count}, ${report.longTasks.totalMs} ms total, max ${report.longTasks.maxMs} ms`,
    `renderer busy     ${report.cpu.busyMs} ms`,
    ...(report.mainCpu ? [`main process busy ${report.mainCpu.busyMs} ms`] : [])
  );
  if (report.slowEvents.length > 0) {
    lines.push(
      `slow events       ${report.slowEvents.map((e) => `${e.name}×${e.count} (max ${e.maxMs} ms)`).join(', ')}`
    );
  }
  if (report.react) {
    lines.push(
      `react commits     ${report.react.commits}`,
      '',
      'Most rendered components:',
      ...report.react.topRenders.map(([name, count]) => `  ${count}  ${name}`)
    );
  }
  if (report.boot) {
    const b = report.boot;
    lines.push(
      '',
      `Launch: main code running ${b.mainEnteredMs ?? '?'} ms, window visible ${b.windowVisibleMs ?? '?'} ms, usable ${b.usableWorkspaceMs ?? '?'} ms after start`,
      '  main-process phases:',
      ...Object.entries(b.phases)
        .sort((x, y) => y[1] - x[1])
        .map(([name, ms]) => `    ${Math.round(ms)} ms  ${name}`),
      '  renderer marks (ms since page start):',
      ...b.rendererMarks.map((m) => `    ${m.ms}  ${m.mark}`)
    );
  }
  const cpuSection = (title: string, cpu: CpuSummary) => [
    '',
    `${title}: CPU self time by source`,
    ...cpu.byPackage.map((b) => `  ${b.ms} ms  ${b.name}`),
    '',
    `${title}: CPU self time by function`,
    ...cpu.topFunctions.map((fn) => `  ${fn.ms} ms  ${fn.name}`),
  ];
  lines.push(
    ...(report.mainCpu ? cpuSection('Main process', report.mainCpu) : []),
    ...cpuSection('Renderer', report.cpu)
  );
  return `${lines.join('\n')}\n`;
}
