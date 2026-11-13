import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptPushPayload, generateVapidKeys, vapidAuthorization } from './web-push';

/** What the receiving browser does with an aes128gcm body (RFC 8291 §3.4). */
function decryptAsBrowser(body: Buffer, browser: ReturnType<typeof createECDH>, auth: Buffer) {
  const salt = body.subarray(0, 16);
  const keyIdLength = body.readUInt8(20);
  const serverPublic = body.subarray(21, 21 + keyIdLength);
  const ciphertext = body.subarray(21 + keyIdLength);
  const shared = browser.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    browser.getPublicKey(),
    serverPublic,
  ]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32));
  const key = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  );
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  expect(plain.at(-1)).toBe(0x02);
  return plain.subarray(0, -1).toString();
}

describe('web push', () => {
  it('encrypts a payload that the subscribed browser can decrypt', () => {
    const browser = createECDH('prime256v1');
    browser.generateKeys();
    const auth = randomBytes(16);
    const subscription = {
      endpoint: 'https://push.example.com/abc',
      keys: {
        p256dh: browser.getPublicKey().toString('base64url'),
        auth: auth.toString('base64url'),
      },
    };

    const body = encryptPushPayload(subscription, Buffer.from('{"title":"Done"}'));

    expect(body.readUInt32BE(16)).toBe(4096);
    expect(decryptAsBrowser(body, browser, auth)).toBe('{"title":"Done"}');
  });

  it('signs a VAPID token for the push service origin', () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization(
      'https://push.example.com/abc',
      keys,
      'mailto:me@example.com',
      0
    );
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(key).toBe(keys.publicKey);
    const [head, claims, signature] = token!.split('.');
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({
      aud: 'https://push.example.com',
      exp: 12 * 60 * 60,
      sub: 'mailto:me@example.com',
    });
    const raw = Buffer.from(keys.publicKey, 'base64url');
    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: raw.subarray(1, 33).toString('base64url'),
        y: raw.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.${claims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature!, 'base64url')
      )
    ).toBe(true);
  });
});
