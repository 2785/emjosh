/**
 * Renderer half of "Record UI Performance Profile": the main process calls
 * `window.__emjoshUiPerf.start()` / `.stop()` around a CPU profile, and this records what the
 * profile can't show: input latency, frame times, long tasks, slow events, and which React
 * components rendered.
 *
 * Imported before React so the React hook is in place when React registers with DevTools.
 * Costs nothing until a recording starts.
 */

import type { UiPerfRendererRecording } from '@core/features/dev-perf/api/ui-perf-report';

type Fiber = {
  tag: number;
  type: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  memoizedProps: unknown;
  memoizedState: unknown;
};

type Recording = {
  inputLatencies: number[];
  slowEvents: { name: string; duration: number }[];
  frames: number[];
  longTasks: number[];
  commits: number;
  renders: Map<string, number>;
  stop(): void;
};

// Function, class, forwardRef, memo and simple memo components.
const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);

let recording: Recording | null = null;
/** The latest committed tree, so a recording starts from what is on screen. */
let lastRoot: { current: Fiber } | null = null;
const seen = new WeakMap<Fiber, { props: unknown; state: unknown }>();

function componentName(type: unknown): string {
  if (!type) return 'Anonymous';
  if (typeof type === 'function') {
    const fn = type as { displayName?: string; name?: string };
    return fn.displayName || fn.name || 'Anonymous';
  }
  const wrapped = type as { displayName?: string; render?: unknown; type?: unknown };
  return wrapped.displayName || componentName(wrapped.render ?? wrapped.type);
}

/**
 * Counts the components that rendered in a commit: those whose props or state object changed
 * since the previous commit. Named so it can be told apart in the CPU profile.
 */
function uiPerfCountCommitRenders(root: Fiber, renders: Map<string, number>): void {
  const stack: Fiber[] = [root];
  while (stack.length > 0) {
    const fiber = stack.pop()!;
    if (COMPONENT_TAGS.has(fiber.tag)) {
      const previous = seen.get(fiber) ?? (fiber.alternate ? seen.get(fiber.alternate) : undefined);
      if (
        !previous ||
        previous.props !== fiber.memoizedProps ||
        previous.state !== fiber.memoizedState
      ) {
        const name = componentName(fiber.type);
        renders.set(name, (renders.get(name) ?? 0) + 1);
      }
      const current = { props: fiber.memoizedProps, state: fiber.memoizedState };
      seen.set(fiber, current);
      if (fiber.alternate) seen.set(fiber.alternate, current);
    }
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
}

function onCommit(root: { current: Fiber }): void {
  lastRoot = root;
  if (!recording) return;
  recording.commits++;
  uiPerfCountCommitRenders(root.current, recording.renders);
}

/** Hooks into React's DevTools interface, alongside a real DevTools hook if there is one. */
function installReactHook(): void {
  const w = window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: Record<string, unknown> };
  const existing = w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (existing) {
    const original = existing.onCommitFiberRoot as ((...args: unknown[]) => void) | undefined;
    existing.onCommitFiberRoot = (...args: unknown[]) => {
      onCommit(args[1] as { current: Fiber });
      original?.(...args);
    };
    return;
  }
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    isDisabled: false,
    inject: () => 1,
    checkDCE: () => {},
    onScheduleFiberRoot: () => {},
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    onCommitFiberRoot: (_rendererId: number, root: { current: Fiber }) => onCommit(root),
  };
}

function start(): void {
  recording?.stop();
  // Note what is on screen now, so the first commit counts only what it re-renders.
  if (lastRoot) uiPerfCountCommitRenders(lastRoot.current, new Map());
  const inputLatencies: number[] = [];
  const slowEvents: { name: string; duration: number }[] = [];
  const frames: number[] = [];
  const longTasks: number[] = [];
  let running = true;
  let last = performance.now();
  const frame = (now: number) => {
    if (!running) return;
    frames.push(now - last);
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // keydown → the next frame: the key's event handlers plus the render they cause.
  const onKey = (event: KeyboardEvent) => {
    const startedAt = event.timeStamp;
    requestAnimationFrame(() => inputLatencies.push(performance.now() - startedAt));
  };
  window.addEventListener('keydown', onKey, true);
  const events = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      slowEvents.push({ name: entry.name, duration: entry.duration });
    }
  });
  events.observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit);
  const tasks = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  });
  tasks.observe({ type: 'longtask' });
  recording = {
    inputLatencies,
    slowEvents,
    frames,
    longTasks,
    commits: 0,
    renders: new Map(),
    stop() {
      running = false;
      window.removeEventListener('keydown', onKey, true);
      events.disconnect();
      tasks.disconnect();
    },
  };
}

function stop(): UiPerfRendererRecording | null {
  const current = recording;
  if (!current) return null;
  current.stop();
  recording = null;
  return {
    inputLatencies: current.inputLatencies,
    slowEvents: current.slowEvents,
    // The first entry spans from start() to the first frame.
    frames: current.frames.slice(1),
    longTasks: current.longTasks,
    reactCommits: current.commits,
    reactRenders: [...current.renders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40),
  };
}

installReactHook();
(window as unknown as { __emjoshUiPerf: unknown }).__emjoshUiPerf = { start, stop };
