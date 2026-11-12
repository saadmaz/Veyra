import { describe, expect, it } from 'vitest';
import { tokenFromHash } from '../src/lib/account';

describe('account links', () => {
  it('read the token from the fragment, and nothing else', () => {
    const token = 'a'.repeat(43);
    expect(tokenFromHash(`#token=${token}`)).toBe(token);
    expect(tokenFromHash('')).toBeNull();
    expect(tokenFromHash('#token=<script>')).toBeNull();
    expect(tokenFromHash('#other=x')).toBeNull();
  });
});
