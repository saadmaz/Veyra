'use client';

import { useState } from 'react';
import { type Billing, formatUsd, plans, unitPriceCents } from '../lib/pricing';
import { Icon } from './icon';

/** Plan cards with a working Monthly / Annual switch. */
export function PlanCards({ trialHref, salesHref }: { trialHref: string; salesHref: string }) {
  const [billing, setBilling] = useState<Billing>('annual');

  return (
    <>
      <fieldset className="billing-toggle">
        <legend className="visually-hidden">Billing period</legend>
        {(['monthly', 'annual'] as const).map((b) => (
          <label key={b} className={billing === b ? 'is-active' : undefined}>
            <input
              type="radio"
              name="billing"
              value={b}
              checked={billing === b}
              onChange={() => setBilling(b)}
            />
            {b === 'monthly' ? 'Monthly' : 'Annual · 2 months free'}
          </label>
        ))}
      </fieldset>

      <div className="plan-grid">
        {plans.map((plan) => (
          <article key={plan.id} className={plan.highlighted ? 'plan plan-highlight' : 'plan'}>
            <div className="plan-head">
              <h2>{plan.name}</h2>
              {plan.highlighted ? <span className="badge">Most popular</span> : null}
            </div>
            <p className="plan-price">
              <strong>
                {plan.monthlyCents === null
                  ? 'Custom'
                  : formatUsd(unitPriceCents(plan.monthlyCents, billing))}
              </strong>
              {plan.monthlyCents === null ? null : (
                <span>/ unit / month{billing === 'annual' ? ', billed annually' : ''}</span>
              )}
            </p>
            <p className="plan-desc">{plan.description}</p>
            <a
              href={plan.monthlyCents === null ? salesHref : trialHref}
              className={plan.highlighted ? 'button button-on-ink' : 'button button-primary'}
            >
              {plan.monthlyCents === null ? 'Talk to sales' : 'Start free trial'}
            </a>
            <ul className="check-list">
              {plan.features.map((f) => (
                <li key={f}>
                  <Icon name="check" size={16} />
                  {f}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </>
  );
}
