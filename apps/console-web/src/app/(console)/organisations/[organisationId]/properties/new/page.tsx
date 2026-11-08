'use client';

import type { CreatePropertyRequest, PropertyDto, PropertyType } from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { Alert, Button, Card, SelectField, TextField } from '@/components/ui';
import { api } from '@/lib/api-client';
import { enumLabel, errorMessage, fieldErrors, PROPERTY_TYPES } from '@/lib/messages';

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

export default function NewPropertyPage() {
  const { organisationId } = useParams<{ organisationId: string }>();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    document.title = 'Add property · VEYRA Console';
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const optional = (name: string) => text(form, name) || undefined;
    const body: CreatePropertyRequest = {
      name: text(form, 'name'),
      code: text(form, 'code').toUpperCase(),
      type: text(form, 'type') as PropertyType,
      addressLine1: text(form, 'addressLine1'),
      addressLine2: optional('addressLine2'),
      city: text(form, 'city'),
      region: optional('region'),
      postalCode: optional('postalCode'),
    };
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<PropertyDto>(
        `/organisations/${organisationId}/properties`,
        body,
      );
      router.push(`/organisations/${organisationId}/properties/${created.id}`);
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  }

  const fields = fieldErrors(error);
  return (
    <>
      <div className="page__header">
        <h1>Add property</h1>
      </div>
      <Card>
        <form className="form" onSubmit={onSubmit} noValidate>
          {error ? <Alert>{errorMessage(error)}</Alert> : null}
          <div className="form__row">
            <TextField
              label="Property name"
              name="name"
              required
              maxLength={120}
              error={fields.name}
            />
            <TextField
              label="Property code"
              name="code"
              required
              maxLength={20}
              hint="Short and unique, for example HVR. Letters, numbers and hyphens."
              error={fields.code}
            />
          </div>
          <SelectField label="Type" name="type" defaultValue="CONDOMINIUM" error={fields.type}>
            {PROPERTY_TYPES.map((type) => (
              <option key={type} value={type}>
                {enumLabel(type)}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Address line 1"
            name="addressLine1"
            required
            maxLength={200}
            autoComplete="address-line1"
            error={fields.addressLine1}
          />
          <TextField
            label="Address line 2 (optional)"
            name="addressLine2"
            maxLength={200}
            autoComplete="address-line2"
            error={fields.addressLine2}
          />
          <div className="form__row">
            <TextField
              label="City"
              name="city"
              required
              maxLength={100}
              autoComplete="address-level2"
              error={fields.city}
            />
            <TextField
              label="Region (optional)"
              name="region"
              maxLength={100}
              autoComplete="address-level1"
              error={fields.region}
            />
            <TextField
              label="Postal code (optional)"
              name="postalCode"
              maxLength={20}
              autoComplete="postal-code"
              error={fields.postalCode}
            />
          </div>
          <p className="muted">
            Country, currency and time zone start as the organisation's. You can change them on the
            property page while it is being set up.
          </p>
          <div className="form__actions">
            <Button type="submit" busy={busy}>
              Add property
            </Button>
            <Link href={`/organisations/${organisationId}`} className="button button--secondary">
              Cancel
            </Link>
          </div>
        </form>
      </Card>
    </>
  );
}
