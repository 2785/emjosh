import type { DevPerfTraceError } from '../contract';
import { getDevPerfClient } from './client';

/** One knob for every trace-capture entry point (process panel button, palette command). */
export const TRACE_CAPTURE_DURATION_MS = 10_000;

export type TraceCaptureOutcome =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

function traceErrorMessage(error: DevPerfTraceError): string {
  switch (error.type) {
    case 'trace_in_progress':
      return 'A trace capture is already in progress';
  }
}

/**
 * Run one trace capture and normalize every failure mode — expected
 * (capture already running) and unexpected (transport errors) — into a
 * user-presentable message.
 */
export async function captureDevPerfTrace(): Promise<TraceCaptureOutcome> {
  try {
    const client = await getDevPerfClient();
    const result = await client.captureTrace({ durationMs: TRACE_CAPTURE_DURATION_MS });
    if (!result.success) return { ok: false, message: traceErrorMessage(result.error) };
    return { ok: true, path: result.data.path };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** How long "Record UI Performance Profile" records. */
export const UI_PROFILE_DURATION_MS = 15_000;

export type UiProfileOutcome =
  | { readonly ok: true; readonly reportPath: string; readonly summary: string }
  | { readonly ok: false; readonly message: string };

const UI_PROFILE_ERRORS = {
  trace_in_progress: 'A profile is already recording',
  no_window: 'There is no window to profile',
  debugger_busy: 'Close the developer tools and try again',
} as const;

export async function recordUiProfile(): Promise<UiProfileOutcome> {
  try {
    const client = await getDevPerfClient();
    const result = await client.recordUiProfile({ durationMs: UI_PROFILE_DURATION_MS });
    if (!result.success) return { ok: false, message: UI_PROFILE_ERRORS[result.error.type] };
    return { ok: true, ...result.data };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
