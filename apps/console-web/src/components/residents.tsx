'use client';

import type { PersonDto } from '@veyra/api-contracts';
import { type FormEvent, useId } from 'react';
import { Alert, Button, SelectField, TextField } from '@/components/ui';
import { api } from '@/lib/api-client';
import { errorMessage, fieldErrors } from '@/lib/messages';
import type { PeriodStatus } from '@/lib/residents';
import { useAction } from '@/lib/use-action';

/** A person that forms can choose: current residents plus anyone added on this page. */
export interface PersonOption {
  id: string;
  fullName: string;
}

const PERIOD_LABELS: Record<PeriodStatus, { text: string; tone: string }> = {
  CURRENT: { text: 'current', tone: 'success' },
  UPCOMING: { text: 'upcoming', tone: 'warning' },
  ENDED: { text: 'ended', tone: 'muted' },
  VOIDED: { text: 'voided', tone: 'muted' },
};

export function PeriodBadge({ status }: { status: PeriodStatus }) {
  const { text, tone } = PERIOD_LABELS[status];
  return <span className={`badge badge--${tone}`}>{text}</span>;
}

export function PersonSelect({
  label,
  name,
  people,
  error,
  hint,
  required = true,
}: {
  label: string;
  name: string;
  people: PersonOption[];
  error?: string | undefined;
  hint?: string;
  required?: boolean;
}) {
  return (
    <SelectField
      label={label}
      name={name}
      defaultValue=""
      required={required}
      error={error}
      {...(hint ? { hint } : {})}
    >
      <option value="">{required ? 'Choose a person' : 'Nobody'}</option>
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {p.fullName}
        </option>
      ))}
    </SelectField>
  );
}

/**
 * Creates a resident profile (name, email, phone and language only: the agreed personal data).
 * Email and phone are optional; the API validates and normalises them.
 */
export function NewPersonForm({
  base,
  submitLabel = 'Add person',
  onCreated,
}: {
  /** …/organisations/:id/properties/:id */
  base: string;
  submitLabel?: string;
  onCreated: (person: PersonDto) => void;
}) {
  const create = useAction();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const optional = (key: string) => {
      const value = String(form.get(key) ?? '').trim();
      return value ? { [key]: value } : {};
    };
    let person: PersonDto | undefined;
    const ok = await create.run(async () => {
      person = await api.post<PersonDto>(`${base}/persons`, {
        fullName: String(form.get('fullName') ?? ''),
        ...optional('email'),
        ...optional('phone'),
        ...optional('preferredLanguage'),
      });
    });
    if (ok && person) {
      formElement.reset();
      onCreated(person);
    }
  }

  const fields = fieldErrors(create.error);
  return (
    <form className="form form--inline" onSubmit={onSubmit} noValidate aria-label="Add a person">
      {create.error ? <Alert>{errorMessage(create.error)}</Alert> : null}
      <TextField
        label="Full name"
        name="fullName"
        required
        maxLength={200}
        autoComplete="off"
        error={fields.fullName}
      />
      <TextField
        label="Email (optional)"
        name="email"
        type="email"
        maxLength={254}
        autoComplete="off"
        error={fields.email}
      />
      <TextField
        label="Phone (optional)"
        name="phone"
        type="tel"
        maxLength={20}
        hint="International format, e.g. +923001234567"
        autoComplete="off"
        error={fields.phone}
      />
      <TextField
        label="Language (optional)"
        name="preferredLanguage"
        maxLength={35}
        hint="For example en or ur-PK"
        autoComplete="off"
        error={fields.preferredLanguage}
      />
      <Button type="submit" busy={create.busy}>
        {submitLabel}
      </Button>
    </form>
  );
}

/** Small inline form that records the last day of a period (move-out, leaving a household). */
export function EndPeriodForm({
  label,
  submitLabel,
  min,
  defaultValue,
  busy,
  onSubmit,
}: {
  label: string;
  submitLabel: string;
  min: string;
  defaultValue: string;
  busy: boolean;
  onSubmit: (endDate: string) => void;
}) {
  const id = useId();
  return (
    <form
      className="form form--inline form--compact"
      noValidate
      aria-label={submitLabel}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(String(new FormData(event.currentTarget).get('endDate') ?? ''));
      }}
    >
      <TextField
        id={id}
        label={label}
        name="endDate"
        type="date"
        required
        min={min}
        defaultValue={defaultValue < min ? min : defaultValue}
      />
      <Button type="submit" variant="secondary" busy={busy}>
        {submitLabel}
      </Button>
    </form>
  );
}

/**
 * Asks why a record is being voided (kept in the audit trail). Native prompt: accessible and
 * keyboard-friendly without custom modal code. Returns null when cancelled or left empty.
 */
export function promptVoidReason(what: string): string | null {
  const reason = window.prompt(
    `Void ${what}? Use this only for records entered by mistake; they stay visible as voided. Why is it being voided?`,
  );
  const trimmed = reason?.trim() ?? '';
  return trimmed ? trimmed.slice(0, 500) : null;
}
