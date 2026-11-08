import type { Request, Response } from 'express';
import type { PresentedCredential } from '../application/identity-provider';

/**
 * How session tokens travel (ADR 0005).
 *   Web:    httpOnly cookie. In production the __Host- prefix makes the browser enforce
 *           Secure, Path=/ and no Domain, so subdomains cannot set or read it.
 *   Mobile: Authorization: Bearer <token>, stored in the platform secure store.
 */
export interface CookieSettings {
  name: string;
  secure: boolean;
}

export function cookieSettings(production: boolean): CookieSettings {
  return production
    ? { name: '__Host-veyra_session', secure: true }
    : { name: 'veyra_session', secure: false };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/** Bearer header wins over a cookie; each token is only valid on its own transport anyway. */
export function readCredential(req: Request, cookie: CookieSettings): PresentedCredential | null {
  const authorization = req.header('authorization');
  if (authorization) {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization.trim());
    return match?.[1] ? { token: match[1], transport: 'MOBILE' } : null;
  }
  const token = readCookie(req.header('cookie'), cookie.name);
  return token ? { token, transport: 'WEB' } : null;
}

export function setSessionCookie(
  res: Response,
  cookie: CookieSettings,
  token: string,
  expiresAt: Date,
): void {
  res.cookie(cookie.name, token, {
    httpOnly: true,
    secure: cookie.secure,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response, cookie: CookieSettings): void {
  res.clearCookie(cookie.name, {
    httpOnly: true,
    secure: cookie.secure,
    sameSite: 'lax',
    path: '/',
  });
}
