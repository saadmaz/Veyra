import { describe, expect, it } from 'vitest';
import { signInSchema, signUpSchema } from '../../src/modules/identity/domain/credentials';
import { Argon2PasswordHasher } from '../../src/modules/identity/infrastructure/argon2-password-hasher';

const valid = {
  email: '  Resident.One@Example.TEST ',
  password: 'correct horse battery',
  displayName: '  Resident One ',
};

describe('sign-up input', () => {
  it('normalises email and display name and defaults the client to web', () => {
    expect(signUpSchema.parse(valid)).toEqual({
      email: 'resident.one@example.test',
      password: 'correct horse battery',
      displayName: 'Resident One',
      client: 'web',
    });
  });

  it('requires at least 12 characters, counting Unicode characters not bytes', () => {
    expect(signUpSchema.safeParse({ ...valid, password: 'elevenchars' }).success).toBe(false);
    expect(signUpSchema.safeParse({ ...valid, password: 'twelve chars' }).success).toBe(true);
    // 12 emoji = 24 UTF-16 units but 12 characters.
    expect(signUpSchema.safeParse({ ...valid, password: '🔑'.repeat(12) }).success).toBe(true);
    expect(signUpSchema.safeParse({ ...valid, password: '🔑'.repeat(11) }).success).toBe(false);
  });

  it('has no composition rules but bounds the length at 128', () => {
    expect(signUpSchema.safeParse({ ...valid, password: 'a'.repeat(128) }).success).toBe(true);
    expect(signUpSchema.safeParse({ ...valid, password: 'a'.repeat(129) }).success).toBe(false);
  });

  it('applies NFKC normalisation so equivalent input hashes identically', () => {
    const composed = signUpSchema.parse({ ...valid, password: 'café-password-1' });
    const decomposed = signUpSchema.parse({ ...valid, password: 'café-password-1' });
    expect(composed.password).toBe(decomposed.password);
  });

  it('rejects invalid emails and strips unknown fields such as role or status', () => {
    expect(signUpSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false);
    const parsed = signUpSchema.parse({ ...valid, role: 'PLATFORM_SUPER_ADMIN', status: 'ACTIVE' });
    expect(parsed).not.toHaveProperty('role');
    expect(parsed).not.toHaveProperty('status');
  });

  it('accepts only known client types', () => {
    expect(signUpSchema.parse({ ...valid, client: 'mobile' }).client).toBe('mobile');
    expect(signUpSchema.safeParse({ ...valid, client: 'admin' }).success).toBe(false);
  });
});

describe('sign-in input', () => {
  it('does not apply the length policy, so short passwords fail as wrong credentials', () => {
    expect(signInSchema.safeParse({ email: valid.email, password: 'short' }).success).toBe(true);
  });

  it('bounds the input size', () => {
    expect(signInSchema.safeParse({ email: valid.email, password: 'a'.repeat(513) }).success).toBe(
      false,
    );
  });
});

describe('argon2id password hasher', () => {
  const hasher = new Argon2PasswordHasher();

  it('produces argon2id hashes with the OWASP baseline parameters and a random salt', async () => {
    const first = await hasher.hash('correct horse battery');
    const second = await hasher.hash('correct horse battery');
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(first).not.toBe(second);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hasher.hash('correct horse battery');
    expect(await hasher.verify(hash, 'correct horse battery')).toBe(true);
    expect(await hasher.verify(hash, 'correct horse batterY')).toBe(false);
  });

  it('never authenticates against a malformed stored hash', async () => {
    expect(await hasher.verify('not-a-hash', 'anything')).toBe(false);
    expect(await hasher.verify('', '')).toBe(false);
  });

  it('flags hashes made with weaker parameters for upgrade', async () => {
    const weak = await new Argon2PasswordHasher({
      memoryCost: 8_192,
      timeCost: 1,
      parallelism: 1,
    }).hash('correct horse battery');
    expect(hasher.needsRehash(weak)).toBe(true);
    expect(hasher.needsRehash(await hasher.hash('correct horse battery'))).toBe(false);
    expect(hasher.needsRehash('garbage')).toBe(true);
  });
});
