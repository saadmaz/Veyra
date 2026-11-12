import { describe, expect, it } from 'vitest';
import { documentFileProblem, expiryText } from '../src/lib/communications';

describe('communications helpers', () => {
  it('accept PDFs and photos up to 20 MB', () => {
    expect(documentFileProblem({ type: 'application/pdf', size: 1000 })).toBeNull();
    expect(documentFileProblem({ type: 'text/html', size: 1000 })).toMatch(/PDF or a photo/);
    expect(documentFileProblem({ type: 'application/pdf', size: 0 })).toMatch(/empty/);
    expect(documentFileProblem({ type: 'application/pdf', size: 21 * 1024 * 1024 })).toMatch(
      /20 MB/,
    );
  });

  it('describe a document expiry', () => {
    expect(expiryText({ expiresOn: null, expiry: 'NONE' })).toBeNull();
    expect(expiryText({ expiresOn: '2026-12-31', expiry: 'VALID' })).toBe('Valid until 2026-12-31');
    expect(expiryText({ expiresOn: '2026-11-20', expiry: 'EXPIRING_SOON' })).toBe(
      'Expires soon (2026-11-20)',
    );
    expect(expiryText({ expiresOn: '2026-01-01', expiry: 'EXPIRED' })).toBe(
      'Expired on 2026-01-01',
    );
  });
});
