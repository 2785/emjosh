import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { generateVapidKeys, type PushSubscriptionJson, type VapidKeys } from './web-push';

export type RemoteDevice = {
  id: string;
  name: string;
  /** SHA-256 of the device's token; the token itself only ever lives on the device. */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number | null;
  push: PushSubscriptionJson | null;
};

type StoredState = {
  version: 1;
  enabled: boolean;
  port: number;
  vapid: VapidKeys;
  devices: RemoteDevice[];
};

export const DEFAULT_REMOTE_CONTROL_PORT = 7425;
/** How long a pairing code works, and how many wrong guesses end it early. */
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
const PAIRING_CODE_ATTEMPTS = 5;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Remote control state in one owner-only JSON file: whether it is on, its port, the Web Push
 * keys, and the paired devices. Pairing codes stay in memory.
 */
export class RemoteControlStore {
  private state: StoredState | null = null;
  private pairing: { code: string; expiresAt: number; attemptsLeft: number } | null = null;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now
  ) {}

  async load(): Promise<StoredState> {
    if (this.state) return this.state;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as StoredState;
      if (parsed.version === 1 && parsed.vapid?.publicKey) this.state = parsed;
    } catch {
      // Missing or unreadable: start fresh below.
    }
    this.state ??= {
      version: 1,
      enabled: false,
      port: DEFAULT_REMOTE_CONTROL_PORT,
      vapid: generateVapidKeys(),
      devices: [],
    };
    return this.state;
  }

  async update(change: Partial<Pick<StoredState, 'enabled' | 'port'>>): Promise<StoredState> {
    const state = await this.load();
    Object.assign(state, change);
    await this.save();
    return state;
  }

  /** A fresh six-digit pairing code, replacing any earlier one. */
  createPairingCode(): { code: string; expiresAt: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = this.now() + PAIRING_CODE_TTL_MS;
    this.pairing = { code, expiresAt, attemptsLeft: PAIRING_CODE_ATTEMPTS };
    return { code, expiresAt };
  }

  /**
   * Exchanges a pairing code for a new device and its token. The code works once; too many
   * wrong guesses or expiry end it.
   */
  async pair(code: string, name: string): Promise<{ device: RemoteDevice; token: string } | null> {
    const pairing = this.pairing;
    if (!pairing || this.now() > pairing.expiresAt) {
      this.pairing = null;
      return null;
    }
    const matches =
      code.length === pairing.code.length &&
      timingSafeEqual(Buffer.from(code), Buffer.from(pairing.code));
    if (!matches) {
      pairing.attemptsLeft--;
      if (pairing.attemptsLeft <= 0) this.pairing = null;
      return null;
    }
    this.pairing = null;
    const token = randomBytes(32).toString('base64url');
    const device: RemoteDevice = {
      id: randomBytes(8).toString('hex'),
      name: name.trim().slice(0, 80) || 'Device',
      tokenHash: hashToken(token),
      createdAt: this.now(),
      lastSeenAt: this.now(),
      push: null,
    };
    const state = await this.load();
    state.devices.push(device);
    await this.save();
    return { device, token };
  }

  /** The device a token belongs to, noting that it was seen. */
  async authenticate(token: string | undefined): Promise<RemoteDevice | null> {
    if (!token) return null;
    const state = await this.load();
    const hash = Buffer.from(hashToken(token));
    const device = state.devices.find(
      (candidate) =>
        candidate.tokenHash.length === hash.length &&
        timingSafeEqual(Buffer.from(candidate.tokenHash), hash)
    );
    if (!device) return null;
    const now = this.now();
    // Saving on every request would be wasteful; a minute's precision is plenty.
    if (device.lastSeenAt === null || now - device.lastSeenAt > 60_000) {
      device.lastSeenAt = now;
      await this.save();
    }
    return device;
  }

  async setPush(deviceId: string, push: PushSubscriptionJson | null): Promise<void> {
    const state = await this.load();
    const device = state.devices.find((candidate) => candidate.id === deviceId);
    if (!device) return;
    device.push = push;
    await this.save();
  }

  async revoke(deviceId: string): Promise<boolean> {
    const state = await this.load();
    const before = state.devices.length;
    state.devices = state.devices.filter((device) => device.id !== deviceId);
    if (state.devices.length === before) return false;
    await this.save();
    return true;
  }

  private async save(): Promise<void> {
    if (!this.state) return;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(temporary, this.file);
    await chmod(this.file, 0o600);
  }
}
