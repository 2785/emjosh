import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto';

/**
 * Web Push (RFC 8291 payload encryption, RFC 8292 VAPID) with node:crypto, for notifying the
 * remote control web app. Notifications go through the browser vendor's push service
 * (Apple's, Google's, Mozilla's); the payload is end-to-end encrypted for the subscribed browser.
 */

export type VapidKeys = {
  /** Uncompressed P-256 public key, base64url: the `applicationServerKey` for subscribing. */
  publicKey: string;
  /** PKCS#8 private key, base64url. */
  privateKey: string;
};

export type PushSubscriptionJson = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from(jwk.y!, 'base64url'),
  ]);
  return {
    publicKey: raw.toString('base64url'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
  };
}

/** The `aes128gcm` body for one push message (RFC 8291 §4), in a single record. */
export function encryptPushPayload(
  subscription: PushSubscriptionJson,
  payload: Uint8Array,
  options: { salt?: Buffer; serverKeys?: ReturnType<typeof createECDH> } = {}
): Buffer {
  const userAgentPublic = Buffer.from(subscription.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(subscription.keys.auth, 'base64url');
  const server = options.serverKeys ?? createECDH('prime256v1');
  if (!options.serverKeys) server.generateKeys();
  const serverPublic = server.getPublicKey();
  const sharedSecret = server.computeSecret(userAgentPublic);
  const salt = options.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), userAgentPublic, serverPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const contentKey = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  );

  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  // 0x02 marks the last (and only) record.
  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(serverPublic.length, 20);
  return Buffer.concat([header, serverPublic, encrypted]);
}

/** The `Authorization` header value authorizing a push to `endpoint` (RFC 8292). */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now = Date.now()
): string {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(now / 1000) + 12 * 60 * 60,
      sub: subject,
    })
  ).toString('base64url');
  const signingInput = `${header}.${claims}`;
  const key = createPrivateKey({
    key: Buffer.from(keys.privateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = sign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `vapid t=${signingInput}.${signature}, k=${keys.publicKey}`;
}

export type PushResult = 'sent' | 'gone' | 'failed';

/**
 * Sends one notification payload (JSON) to a subscription. `gone` means the subscription is no
 * longer valid and should be forgotten.
 */
export async function sendWebPush(
  subscription: PushSubscriptionJson,
  payload: unknown,
  keys: VapidKeys,
  subject: string
): Promise<PushResult> {
  const body = encryptPushPayload(subscription, Buffer.from(JSON.stringify(payload)));
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint, keys, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(24 * 60 * 60),
      Urgency: 'high',
    },
    body: new Uint8Array(body),
  });
  if (response.status === 404 || response.status === 410) return 'gone';
  return response.ok ? 'sent' : 'failed';
}
