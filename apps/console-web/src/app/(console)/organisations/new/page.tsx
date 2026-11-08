'use client';

import type { CreateOrganisationRequest, OrganisationDto } from '@veyra/api-contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, SelectField, TextField } from '@/components/ui';
import { api } from '@/lib/api-client';
import { errorMessage, fieldErrors } from '@/lib/messages';
import { suggestSlug } from '@/lib/slug';

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export default function NewOrganisationPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const timeZones = useMemo(() => Intl.supportedValuesOf('timeZone'), []);
  const [timeZone, setTimeZone] = useState('UTC');

  useEffect(() => {
    document.title = 'Create organisation · VEYRA Console';
    setTimeZone(browserTimeZone());
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: CreateOrganisationRequest = {
      name,
      slug,
      countryCode: String(form.get('countryCode') ?? '')
        .trim()
        .toUpperCase(),
      defaultCurrency: String(form.get('defaultCurrency') ?? '')
        .trim()
        .toUpperCase(),
      defaultTimeZone: timeZone,
    };
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<OrganisationDto>('/organisations', body);
      router.push(`/organisations/${created.id}`);
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  }

  const fields = fieldErrors(error);
  return (
    <>
      <div className="page__header">
        <h1>Create organisation</h1>
      </div>
      <Card>
        <form className="form" onSubmit={onSubmit} noValidate>
          {error ? <Alert>{errorMessage(error)}</Alert> : null}
          <TextField
            label="Organisation name"
            name="name"
            required
            maxLength={120}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (!slugEdited) setSlug(suggestSlug(event.target.value));
            }}
            error={fields.name}
          />
          <TextField
            label="Web address"
            name="slug"
            required
            maxLength={63}
            hint="Lower-case letters, numbers and hyphens. Used in links."
            value={slug}
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value);
            }}
            error={fields.slug}
          />
          <div className="form__row">
            <TextField
              label="Country code"
              name="countryCode"
              required
              maxLength={2}
              autoComplete="country"
              hint="Two letters, for example PK or LK. Cannot be changed later."
              error={fields.countryCode}
            />
            <TextField
              label="Currency"
              name="defaultCurrency"
              required
              maxLength={3}
              hint="Three letters, for example PKR or LKR. Cannot be changed later."
              error={fields.defaultCurrency}
            />
          </div>
          <SelectField
            label="Time zone"
            name="defaultTimeZone"
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
            error={fields.defaultTimeZone}
          >
            <option value="UTC">UTC</option>
            {timeZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll('_', ' ')}
              </option>
            ))}
          </SelectField>
          <div className="form__actions">
            <Button type="submit" busy={busy}>
              Create organisation
            </Button>
            <Link href="/organisations" className="button button--secondary">
              Cancel
            </Link>
          </div>
        </form>
      </Card>
    </>
  );
}
