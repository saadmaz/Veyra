import { hash, parseOptions, verify } from '@node-rs/argon2';
import type { PasswordHasher } from '../application/ports';

/**
 * argon2id with the OWASP Password Storage Cheat Sheet baseline: 19 MiB memory, 2 iterations,
 * 1 lane. Raise these (never lower) as hardware allows; existing hashes are upgraded at the
 * next successful sign-in through needsRehash.
 */
export interface Argon2Params {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export const ARGON2_PARAMS: Readonly<Argon2Params> = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

// Algorithm.Argon2id. The package exports it as a `const enum`, which isolatedModules cannot inline.
const ARGON2ID = 2;

export class Argon2PasswordHasher implements PasswordHasher {
  constructor(private readonly params: Readonly<Argon2Params> = ARGON2_PARAMS) {}

  hash(password: string): Promise<string> {
    return hash(password, { ...this.params, algorithm: ARGON2ID });
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      // A malformed stored hash must never authenticate, and must not leak details.
      return false;
    }
  }

  needsRehash(passwordHash: string): boolean {
    try {
      const options = parseOptions(passwordHash);
      return (
        options.algorithm !== ARGON2ID ||
        options.memoryCost < this.params.memoryCost ||
        options.timeCost < this.params.timeCost ||
        options.parallelism < this.params.parallelism
      );
    } catch {
      return true;
    }
  }
}
