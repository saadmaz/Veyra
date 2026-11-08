import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes = 256 bits of entropy, base64url encoded (43 characters, no padding). */
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Creates a new opaque session token. Returned to the client once; never stored. */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The only form of the token the server keeps. A database leak therefore exposes no usable
 * tokens. A fast hash is correct here (unlike passwords): the input is 256 random bits, so
 * brute force is infeasible.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Rejects malformed tokens before any database lookup. */
export function isWellFormedSessionToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}
