import { hostRefKey, type HostRef } from '@emdash/core/primitives/host/api';
import { nativePathIdentityKey, stableNativePathDisplay } from '@emdash/core/primitives/path/api';

const identityKeys = new Map<string, string>();
/** Generous for a few hundred workspaces; the cache starts over when full. */
const MAX_CACHED_IDENTITY_KEYS = 10_000;

/**
 * Canonical path identity; display and execution continue using the original string.
 * Cached: every host snapshot computes it for every workspace path, and it is pure.
 */
export function workspacePathIdentityKey(path: string): string {
  const cached = identityKeys.get(path);
  if (cached !== undefined) return cached;
  const key = nativePathIdentityKey(path);
  if (identityKeys.size >= MAX_CACHED_IDENTITY_KEYS) identityKeys.clear();
  identityKeys.set(path, key);
  return key;
}

export function stableWorkspacePathDisplay(current: string, incoming: string): string {
  return stableNativePathDisplay(current, incoming);
}

export function hostWorkspacePathIdentityKey(host: HostRef, path: string): string {
  return `${hostRefKey(host)}\0${workspacePathIdentityKey(path)}`;
}

export function storedWorkspacePathIdentityKey(
  location: 'local' | 'remote',
  sshConnectionId: string | null,
  path: string
): string {
  const hostKey = location === 'local' ? 'local' : `remote:${sshConnectionId ?? ''}`;
  return `${hostKey}\0${workspacePathIdentityKey(path)}`;
}
