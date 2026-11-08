/**
 * Validates a post-sign-in redirect target. Only same-site paths are allowed, so a crafted link
 * such as /sign-in?next=https://evil.example cannot send users elsewhere (open redirect).
 */
export function safeNextPath(
  value: string | null | undefined,
  fallback = '/organisations',
): string {
  if (!value) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  // Control characters (tab, newline...) are stripped by URL parsers and can disguise a host.
  if ([...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return fallback;
  try {
    // Resolving against a dummy origin must not change the origin.
    const url = new URL(value, 'https://console.invalid');
    if (url.origin !== 'https://console.invalid') return fallback;
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}

export function signInPath(next?: string): string {
  return next ? `/sign-in?next=${encodeURIComponent(safeNextPath(next))}` : '/sign-in';
}

/**
 * Invitation links carry the token in the URL fragment (#token=...). Fragments are never sent
 * to servers, so the token stays out of server logs and Referer headers.
 */
export function readInvitationToken(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const token = params.get('token');
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export function invitationLink(origin: string, token: string): string {
  return `${origin}/invitations/accept#token=${token}`;
}
