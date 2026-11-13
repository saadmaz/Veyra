/**
 * External destinations for the public site. The console URL follows the same convention as the
 * console's API base URL: an environment variable with a local-development default.
 */
const consoleUrl = (process.env.NEXT_PUBLIC_CONSOLE_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);

export const links = {
  signIn: `${consoleUrl}/sign-in`,
  signUp: `${consoleUrl}/sign-up`,
};

/**
 * The primary "talk to us" action. When a contact address is configured it opens an email;
 * otherwise it falls back to starting a trial, so no button ever points nowhere.
 */
export function contactAction(): { href: string; label: string } {
  const email = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim();
  return email
    ? { href: `mailto:${email}`, label: 'Talk to us' }
    : { href: links.signUp, label: 'Start free trial' };
}
