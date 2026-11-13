import { escapeHtml, layout, type RenderedEmail } from '../render';

export interface AccountEmailInput {
  kind: 'verify-email' | 'reset-password';
  displayName: string;
  /** Absolute URL with the single-use token: HTTPS, or http://localhost in development. */
  url: string;
  expiresAt: Date;
}

const COPY = {
  'verify-email': {
    subject: 'Confirm your email address for VEYRA',
    lead: 'Please confirm that this is your email address.',
    button: 'Confirm email address',
    ignore: 'If you did not create a VEYRA account, you can ignore this email.',
  },
  'reset-password': {
    subject: 'Reset your VEYRA password',
    lead: 'Someone asked to reset the password of your VEYRA account.',
    button: 'Choose a new password',
    ignore:
      'If it was not you, ignore this email: your password stays as it is. Resetting it signs you out everywhere.',
  },
} as const;

/** Email verification and password reset (Phase 14 Part 1). */
export function accountEmail(input: AccountEmailInput): RenderedEmail {
  if (!/^(https:\/\/|http:\/\/localhost[:/])/.test(input.url)) {
    throw new Error('url must be an absolute HTTPS URL');
  }
  const copy = COPY[input.kind];
  const expiry = input.expiresAt.toISOString().slice(0, 16).replace('T', ' ');
  const greeting = `Hello ${input.displayName},`;
  const html = layout(
    copy.subject,
    `<p style="margin:0 0 16px;">${escapeHtml(greeting)}</p>
<p style="margin:0 0 16px;">${escapeHtml(copy.lead)}</p>
<p style="margin:0 0 24px;"><a href="${escapeHtml(input.url)}" style="display:inline-block;background:#18181b;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;">${escapeHtml(copy.button)}</a></p>
<p style="margin:0;font-size:13px;color:#5b616b;">This link expires on ${expiry} UTC and can be used once. ${escapeHtml(copy.ignore)}</p>`,
  );
  const text = [
    greeting,
    '',
    copy.lead,
    '',
    `${copy.button}: ${input.url}`,
    '',
    `This link expires on ${expiry} UTC and can be used once. ${copy.ignore}`,
  ].join('\n');
  return { subject: copy.subject, html, text };
}
