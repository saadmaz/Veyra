import { escapeHtml, layout, type RenderedEmail } from '../render';

export interface InvitationEmailInput {
  inviteeName: string | null;
  inviterName: string;
  organisationName: string;
  propertyName: string | null;
  roleLabel: string;
  /** Absolute HTTPS URL containing the single-use invitation token. */
  acceptUrl: string;
  expiresAt: Date;
}

/** Invitation to join an organisation/property with a role (Phase 2, journey J2). */
export function invitationEmail(input: InvitationEmailInput): RenderedEmail {
  if (!/^https:\/\//.test(input.acceptUrl)) {
    throw new Error('acceptUrl must be an absolute HTTPS URL');
  }
  const where = input.propertyName
    ? `${input.propertyName} (${input.organisationName})`
    : input.organisationName;
  const greeting = input.inviteeName ? `Hello ${input.inviteeName},` : 'Hello,';
  const expiry = input.expiresAt.toISOString().slice(0, 16).replace('T', ' ');
  const subject = `${input.inviterName} invited you to ${where} on VEYRA`;

  const html = layout(
    subject,
    `<p style="margin:0 0 16px;">${escapeHtml(greeting)}</p>
<p style="margin:0 0 16px;">${escapeHtml(input.inviterName)} has invited you to join <strong>${escapeHtml(where)}</strong> as <strong>${escapeHtml(input.roleLabel)}</strong>.</p>
<p style="margin:0 0 24px;"><a href="${escapeHtml(input.acceptUrl)}" style="display:inline-block;background:#1f4e46;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;">Accept invitation</a></p>
<p style="margin:0;font-size:13px;color:#5b616b;">This link expires on ${expiry} UTC and can be used once. If you did not expect this invitation, you can ignore this email.</p>`,
  );

  const text = [
    greeting,
    '',
    `${input.inviterName} has invited you to join ${where} as ${input.roleLabel}.`,
    '',
    `Accept the invitation: ${input.acceptUrl}`,
    '',
    `This link expires on ${expiry} UTC and can be used once. If you did not expect this invitation, you can ignore this email.`,
  ].join('\n');

  return { subject, html, text };
}
