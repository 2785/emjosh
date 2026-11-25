import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion } from './versions';

describe('versions', () => {
  it.each([
    ['codex-cli 0.172.0', '0.172.0'],
    ['2.1.318 (Claude Code)', '2.1.318'],
    ['opencode v2.4.1', '2.4.1'],
    ['1.5.17', '1.5.17'],
    ['no version here', null],
  ])('parses %s', (output, expected) => {
    expect(parseVersion(output)).toBe(expected);
  });

  it('compares numerically and ranks pre-releases lower', () => {
    expect(compareVersions('0.172.0', '0.91.0')).toBeGreaterThan(0);
    expect(compareVersions('2.1.9', '2.1.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
});
