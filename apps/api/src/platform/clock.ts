/** Source of the current time. Injected so time-dependent rules (expiry) are testable. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

export const systemClock: Clock = { now: () => new Date() };
