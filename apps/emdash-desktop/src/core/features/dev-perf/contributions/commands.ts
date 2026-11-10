import { PRODUCT_NAME } from '@core/primitives/app-identity/api/app-identity';
import { defineCommand } from '@core/primitives/commands/api';

export const devProcessPanelCommand = defineCommand({
  id: 'devPerf.processPanel',
  title: 'Open Process Panel',
  description: `Show live CPU and memory usage for every ${PRODUCT_NAME} process`,
  category: 'Developer',
  icon: 'activity',
});

export const devPerfCaptureTraceCommand = defineCommand({
  id: 'devPerf.captureTrace',
  title: 'Capture Performance Trace',
  description: 'Record a 10-second contentTracing trace to a file',
  category: 'Developer',
  icon: 'gauge',
});

export const devPerfRecordUiProfileCommand = defineCommand({
  id: 'devPerf.recordUiProfile',
  title: 'Record UI Performance Profile',
  description:
    'Profile typing, scrolling and rendering for 15 seconds and write a report of what is slow',
  category: 'Developer',
  icon: 'gauge',
});

export const DEV_PERF_COMMAND_DEFS = [
  devProcessPanelCommand,
  devPerfCaptureTraceCommand,
  devPerfRecordUiProfileCommand,
] as const;
