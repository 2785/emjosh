import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

type JsonObject = Record<string, unknown>;

async function readObject(file: string): Promise<{ data: JsonObject; raw: string | null }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { data: {}, raw: null };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not plain JSON, not modifying it: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object, not modifying it.`);
  }
  return { data: parsed as JsonObject, raw };
}

function indentOf(raw: string | null): string | number {
  const match = raw?.match(/^\{\r?\n([ \t]+)"/);
  return match?.[1] ?? 2;
}

export async function readJsonKey(file: string, key: string): Promise<unknown> {
  const { data } = await readObject(file);
  return data[key];
}

/**
 * Sets one top-level key in a JSON config file other programs also write.
 * Each attempt re-reads the file, changes only `key`, writes a temporary sibling and renames it
 * over the file, so readers never see a partial file. The file is re-read afterwards and the
 * write repeated if a concurrent writer replaced it without the key.
 */
export async function writeJsonKey(
  file: string,
  key: string,
  value: unknown,
  options: { attempts?: number } = {}
): Promise<void> {
  const target = await fs.realpath(file).catch(() => file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const attempts = options.attempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { data, raw } = await readObject(target);
    data[key] = value;
    const temp = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    );
    const mode = await fs
      .stat(target)
      .then((s) => s.mode & 0o777)
      .catch(() => 0o600);
    try {
      await fs.writeFile(temp, `${JSON.stringify(data, null, indentOf(raw))}\n`, { mode });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
    const after = await readObject(target);
    if (JSON.stringify(after.data[key]) === JSON.stringify(value)) return;
  }
  throw new Error(`${target} kept changing while writing "${key}"; try again.`);
}
