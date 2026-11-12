'use client';

import type { EscalationContactDto } from '@veyra/api-contracts';
import { INCIDENT_CATEGORY_LABELS } from '@/lib/governance';
import { Badge } from './ui';

/** Escalation contacts with their phone numbers, in the order to call them. */
export function ContactList({ contacts }: { contacts: EscalationContactDto[] }) {
  return (
    <ul className="list" aria-label="Escalation contacts">
      {contacts.map((c) => (
        <li key={c.id} className="list__item">
          <div>
            <p className="list__primary">
              {c.name} · <a href={`tel:${c.phone.replace(/[^+0-9]/g, '')}`}>{c.phone}</a>{' '}
              {c.active ? null : <Badge>retired</Badge>}
            </p>
            <p className="list__meta">
              {c.role}
              {c.email ? ` · ${c.email}` : ''} ·{' '}
              {c.categories.length === 0
                ? 'every kind of incident'
                : c.categories.map((k) => INCIDENT_CATEGORY_LABELS[k]).join(', ')}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
