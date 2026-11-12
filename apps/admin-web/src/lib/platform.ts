import type { PlatformOrganisationDto, SupportAccessDto } from '@veyra/api-contracts';

export const SUBSCRIPTION_STATUS_LABELS = {
  TRIAL: 'Trial',
  ACTIVE: 'Active',
  PAST_DUE: 'Payment overdue',
  CANCELLED: 'Cancelled',
} as const;

export const SUPPORT_STATUS_LABELS: Record<SupportAccessDto['status'], string> = {
  REQUESTED: 'Waiting for the customer',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  REVOKED: 'Revoked',
};

const dateTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
export const when = (iso: string) => dateTime.format(new Date(iso));

/** "Enterprise · Trial until 12 Dec 2026", or "No subscription". */
export function planSummary(o: PlatformOrganisationDto): string {
  const s = o.subscription;
  if (!s) return 'No subscription';
  const status =
    s.status === 'TRIAL' && s.trialEndsAt
      ? `Trial until ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(s.trialEndsAt))}`
      : SUBSCRIPTION_STATUS_LABELS[s.status];
  return `${s.planName} · ${status}`;
}

/** Whether a support grant is open right now. */
export const supportLabel = (s: SupportAccessDto) =>
  s.active ? `Open until ${when(s.endsAt ?? s.createdAt)}` : SUPPORT_STATUS_LABELS[s.status];

/** Checks the plan change form before sending; null when it is fine. */
export function planChangeProblem(form: {
  status: string;
  trialEndsOn: string;
  reason: string;
}): string | null {
  if (!form.reason.trim()) return 'Give a reason: the customer sees it in their history.';
  if (form.status === 'TRIAL' && !form.trialEndsOn) return 'A trial needs an end date.';
  return null;
}
