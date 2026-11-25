const VERSION_PATTERN = /(?<![\d.])(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

/** First version-like token in a CLI's `--version` output, e.g. "codex-cli 0.172.0" -> "0.172.0". */
export function parseVersion(output: string): string | null {
  return output.match(VERSION_PATTERN)?.[1] ?? null;
}

/** Positive when `a` is newer than `b`. Pre-release suffixes sort before the plain release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = '', pre] = v.split(/[-+]/, 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < Math.max(left.nums.length, right.nums.length); i++) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre && !right.pre) return -1;
  if (!left.pre && right.pre) return 1;
  return 0;
}
