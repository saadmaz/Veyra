import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes = 256 bits of entropy, base64url encoded (43 characters, no padding). */
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Bearer secrets handed to a client once (session tokens, invitation tokens). The server keeps
 * only the SHA-256 hash, so a database leak exposes no usable tokens. A fast hash is correct
 * here, unlike for passwords: the input has 256 random bits, so brute force is infeasible.
 */
export function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Rejects malformed tokens before any database lookup. */
export function isWellFormedOpaqueToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}
