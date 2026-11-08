export type SessionClientType = 'WEB' | 'MOBILE';

export interface SessionLifetime {
  /** Session ends after this long without activity. */
  idleMs: number;
  /** Session ends this long after sign-in, regardless of activity. */
  absoluteMs: number;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * Lifetimes per client (ADR 0005). Web sessions are short because browsers are shared and
 * exposed to XSS; mobile tokens live in the platform secure store.
 */
export const SESSION_LIFETIMES: Readonly<Record<SessionClientType, SessionLifetime>> = {
  WEB: { idleMs: 30 * MINUTE, absoluteMs: 7 * DAY },
  MOBILE: { idleMs: 30 * DAY, absoluteMs: 90 * DAY },
};

/** Activity extends the idle expiry at most once per interval, to limit database writes. */
export const SESSION_TOUCH_INTERVAL_MS = MINUTE;

export interface SessionExpiry {
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export function initialExpiry(client: SessionClientType, now: Date): SessionExpiry {
  const lifetime = SESSION_LIFETIMES[client];
  return {
    idleExpiresAt: new Date(now.getTime() + Math.min(lifetime.idleMs, lifetime.absoluteMs)),
    absoluteExpiresAt: new Date(now.getTime() + lifetime.absoluteMs),
  };
}

export interface SessionState {
  client: SessionClientType;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

/** A session is usable only if it is not revoked and neither expiry has passed. */
export function isSessionActive(session: SessionState, now: Date): boolean {
  return (
    session.revokedAt === null &&
    now.getTime() < session.idleExpiresAt.getTime() &&
    now.getTime() < session.absoluteExpiresAt.getTime()
  );
}

/**
 * The new idle expiry after activity at `now`, or null when no write is needed yet. Never
 * extends past the absolute expiry.
 */
export function refreshedIdleExpiry(session: SessionState, now: Date): Date | null {
  if (now.getTime() - session.lastSeenAt.getTime() < SESSION_TOUCH_INTERVAL_MS) return null;
  const idle = now.getTime() + SESSION_LIFETIMES[session.client].idleMs;
  return new Date(Math.min(idle, session.absoluteExpiresAt.getTime()));
}
