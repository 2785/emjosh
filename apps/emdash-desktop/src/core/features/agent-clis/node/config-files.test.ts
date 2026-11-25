import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJsonKey, writeJsonKey } from './config-files';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cli-config-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('writeJsonKey', () => {
  it('changes only the key and keeps indentation and mode', async () => {
    const file = path.join(dir, 'claude.json');
    await fs.writeFile(file, '{\n    "a": 1,\n    "autoUpdates": true,\n    "n": {"x": [1]}\n}\n', {
      mode: 0o640,
    });
    await writeJsonKey(file, 'autoUpdates', false);
    expect(await fs.readFile(file, 'utf8')).toBe(
      '{\n    "a": 1,\n    "autoUpdates": false,\n    "n": {\n        "x": [\n            1\n        ]\n    }\n}\n'
    );
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
  });

  it('leaves no temporary files behind', async () => {
    const file = path.join(dir, 'c.json');
    await fs.writeFile(file, '{}');
    await writeJsonKey(file, 'k', 'v');
    expect(await fs.readdir(dir)).toEqual(['c.json']);
  });

  it('creates a missing file', async () => {
    const file = path.join(dir, 'new.json');
    await writeJsonKey(file, 'update', 'auto');
    expect(await readJsonKey(file, 'update')).toBe('auto');
  });

  it('writes through a symlink without replacing it', async () => {
    const real = path.join(dir, 'real.json');
    const link = path.join(dir, 'link.json');
    await fs.writeFile(real, '{"a":1}');
    await fs.symlink(real, link);
    await writeJsonKey(link, 'a', 2);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readJsonKey(real, 'a')).toBe(2);
  });

  it('refuses to overwrite a file that is not plain JSON', async () => {
    const file = path.join(dir, 'opencode.json');
    const text = '{\n  // comment\n  "update": "auto"\n}';
    await fs.writeFile(file, text);
    await expect(writeJsonKey(file, 'update', 'disable')).rejects.toThrow(/not plain JSON/);
    expect(await fs.readFile(file, 'utf8')).toBe(text);
  });

  it('keeps keys another writer added between reads', async () => {
    const file = path.join(dir, 'c.json');
    await fs.writeFile(file, '{"a":1}');
    await writeJsonKey(file, 'k', 1);
    await fs.writeFile(file, JSON.stringify({ a: 1, k: 1, added: true }));
    await writeJsonKey(file, 'k', 2);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ a: 1, k: 2, added: true });
  });
});
