import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/*
 * Time-based one-time passwords (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), the secret
 * box that keeps TOTP secrets encrypted at rest (AES-256-GCM), and recovery codes. Built on
 * node:crypto, so no dependency is needed.
 */

export const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 as authenticator apps expect. */
export const newTotpSecret = () => base32Encode(randomBytes(20));

export const stepAt = (now: Date) => Math.floor(now.getTime() / 1000 / STEP_SECONDS);

/** The code for one time step (RFC 4226 dynamic truncation). */
export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = (mac[mac.length - 1] as number) & 15;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * The time step a code matches, allowing one step of clock drift either way, and only steps
 * after the last one accepted (so a code cannot be used twice). Null when it does not match.
 */
export function matchTotp(
  secret: Buffer,
  code: string,
  now: Date,
  lastUsedStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepAt(now);
  for (const step of [current - 1, current, current + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

/** The link authenticator apps read from a QR code. */
export function otpauthUri(secret: string, account: string) {
  const label = encodeURIComponent(`VEYRA:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=VEYRA&algorithm=SHA1&digits=6&period=30`;
}

/** AES-256-GCM with a 32-byte key: "v1:<iv>:<tag>:<ciphertext>", base64url parts. */
export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join(':');
}

export function open(key: Buffer, sealed: string): string {
  const [version, iv, tag, data] = sealed.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Ten recovery codes such as "7KQ2-M9XD", easy to read aloud and type. */
export function newRecoveryCodes(count = 10): string[] {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(8);
    const raw = Array.from(bytes, (b) => chars[b % chars.length]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

/** Recovery codes are compared without case or the dash. */
export const normaliseRecoveryCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
