/**
 * Public list prices. Money is held in integer minor units (US cents), never floating point.
 * Annual billing gives two months free: the monthly-equivalent price is 10/12 of the monthly
 * price, rounded half-up to the nearest cent.
 */
export type Billing = 'monthly' | 'annual';

export interface Plan {
  id: 'starter' | 'growth' | 'enterprise';
  name: string;
  /** Price per unit per month on monthly billing, in US cents. `null` means quoted. */
  monthlyCents: number | null;
  description: string;
  features: string[];
  highlighted?: boolean;
}

export const plans: Plan[] = [
  {
    id: 'starter',
    name: 'Starter',
    monthlyCents: 160,
    description: 'For a single community getting organised.',
    features: [
      '1 property, up to 300 units',
      'Residents, visitors, maintenance',
      'Announcements & documents',
      'Email support',
    ],
  },
  {
    id: 'growth',
    name: 'Growth',
    monthlyCents: 240,
    description: 'For operators running several properties.',
    features: [
      'Unlimited properties up to 2,000 units',
      'Everything in Starter',
      'Finance, billing & reconciliation',
      'Approvals, governance, assets',
      'Webhooks & API',
    ],
    highlighted: true,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    monthlyCents: null,
    description: 'For portfolios with advanced security needs.',
    features: [
      'Everything in Growth',
      'SSO & SCIM',
      'Data residency options',
      'Hardware access integrations',
      'Dedicated success manager',
    ],
  },
];

/** Monthly-equivalent price per unit for the chosen billing period, in cents. */
export function unitPriceCents(monthlyCents: number, billing: Billing): number {
  if (!Number.isInteger(monthlyCents) || monthlyCents < 0) {
    throw new RangeError('monthlyCents must be a non-negative integer');
  }
  return billing === 'monthly' ? monthlyCents : Math.floor((monthlyCents * 10 + 6) / 12);
}

/** Formats US cents as dollars, e.g. 240 → "$2.40". */
export function formatUsd(cents: number): string {
  const dollars = Math.trunc(cents / 100);
  const rest = String(Math.abs(cents % 100)).padStart(2, '0');
  return `$${dollars}.${rest}`;
}

export const comparison: { feature: string; values: [string, string, string] }[] = [
  { feature: 'Properties', values: ['1', 'Unlimited', 'Unlimited'] },
  { feature: 'Resident & staff apps', values: ['yes', 'yes', 'yes'] },
  { feature: 'Finance ledger & billing', values: ['no', 'yes', 'yes'] },
  { feature: 'Bank reconciliation', values: ['no', 'yes', 'yes'] },
  { feature: 'Approvals & governance', values: ['no', 'yes', 'yes'] },
  { feature: 'Webhooks & REST API', values: ['no', 'yes', 'yes'] },
  { feature: 'SSO / SCIM', values: ['no', 'no', 'yes'] },
  { feature: 'Data residency', values: ['no', 'no', 'yes'] },
  { feature: 'Support', values: ['Email', 'Priority', 'Dedicated'] },
];

export const faqs: { q: string; a: string }[] = [
  {
    q: 'What counts as a unit?',
    a: 'Any home, apartment or villa you manage. Common areas and parking bays are free.',
  },
  {
    q: 'Can we bring our own payment gateway?',
    a: 'Yes. Payment providers sit behind adapters, so the core system is not tied to one gateway.',
  },
  {
    q: 'Where is our data stored?',
    a: 'In the region you choose at sign-up. Enterprise plans can pin data to a specific country.',
  },
  {
    q: 'Do you have ISO 27001 or SOC 2?',
    a: 'Not yet. We publish our security model and will only claim certifications after formal audits.',
  },
];
