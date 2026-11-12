/**
 * Reads the single-use token from a link's #fragment ("#token=..."). Links carry tokens in the
 * fragment so browsers never send them to a server, a log or a Referer header.
 */
export function tokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token && /^[A-Za-z0-9_-]{20,100}$/.test(token) ? token : null;
}
