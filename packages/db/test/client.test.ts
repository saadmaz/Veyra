import { describe, expect, it } from 'vitest';
import { createDbClient } from '../src/client';

describe('createDbClient', () => {
  it('rejects non-PostgreSQL URLs before creating a client', () => {
    expect(() => createDbClient('mysql://localhost/veyra')).toThrow(/PostgreSQL/);
    expect(() => createDbClient('')).toThrow(/PostgreSQL/);
  });

  it('creates a client lazily without connecting', async () => {
    const client = createDbClient('postgresql://veyra:veyra@127.0.0.1:1/veyra');
    expect(typeof client.$queryRaw).toBe('function');
    await client.$disconnect();
  });
});
