'use client';

import type {
  CreateInvitationResponse,
  OrganisationDetailResponse,
  Paginated,
  PersonDetailResponse,
  PropertyDetailResponse,
  UnitDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import { enumLabel, errorMessage, fieldErrors } from '@/lib/messages';
import { invitationLink } from '@/lib/navigation';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';

/**
 * A resident's profile as property staff see it: contact details, their records in this
 * property, emergency contacts, and an invitation to link a login. The API enforces every rule.
 */
export default function PersonPage() {
  const { organisationId, propertyId, personId } = useParams<{
    organisationId: string;
    propertyId: string;
    personId: string;
  }>();
  const propertyBase = `/organisations/${organisationId}/properties/${propertyId}`;
  const base = `${propertyBase}/persons/${personId}`;
  const detail = useApiQuery<PersonDetailResponse>(base);
  const property = useApiQuery<PropertyDetailResponse>(propertyBase);
  const organisation = useApiQuery<OrganisationDetailResponse>(`/organisations/${organisationId}`);
  // Unit numbers for the records list (records carry only unit ids).
  const units = useApiQuery<Paginated<UnitDto>>(`${propertyBase}/units?limit=200`);

  useEffect(() => {
    if (detail.status === 'success')
      document.title = `${detail.data.person.fullName} · VEYRA Console`;
  }, [detail]);

  if (detail.status === 'loading') return <LoadingState label="Loading resident" />;
  if (detail.status === 'error') {
    if (detail.error instanceof ApiRequestError && detail.error.status === 404) {
      return (
        <EmptyState title="Resident not found">
          They are not a resident of this property, or you do not have access.
        </EmptyState>
      );
    }
    return <ErrorState error={detail.error} onRetry={detail.reload} />;
  }

  const { person, ownerships, tenancies, household, emergencyContacts } = detail.data;
  const canManage =
    property.status === 'success' &&
    property.data.permissions.includes('property.resident.manage') &&
    property.data.status !== 'ARCHIVED' &&
    person.status === 'ACTIVE';
  const canInvite =
    organisation.status === 'success' &&
    organisation.data.permissions.includes('organisation.member.invite') &&
    person.status === 'ACTIVE';
  const unitNumber = (unitId: string) =>
    units.status === 'success' ? units.data.data.find((u) => u.id === unitId)?.number : undefined;
  const unitLink = (unitId: string, fallback: string) => {
    const number = unitNumber(unitId);
    return (
      <Link href={`${propertyBase}/units/${unitId}`}>{number ? `unit ${number}` : fallback}</Link>
    );
  };
  const period = (from: string, to: string | null) => `${from} – ${to ?? 'present'}`;

  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href={propertyBase}>
          {property.status === 'success' ? property.data.name : 'Property'}
        </Link>
      </nav>
      <div className="page__header">
        <h1>{person.fullName}</h1>
        <div className="form__actions">
          {person.linked ? <span className="badge badge--success">uses the app</span> : null}
          {person.status !== 'ACTIVE' ? <StatusBadge status={person.status} /> : null}
        </div>
      </div>

      <Details base={base} detail={detail.data} canManage={canManage} onSaved={detail.reload} />

      <Card title="Records in this property">
        {ownerships.length + tenancies.length + household.length === 0 ? (
          <p className="muted">
            No ownership, tenancy or household records yet. Open a unit to add one.
          </p>
        ) : (
          <ul className="list" aria-label="Records">
            {ownerships.map((o) => (
              <li key={o.id} className="list__item">
                <div>
                  <p className="list__primary">
                    Owner of {unitLink(o.unitId, 'a unit')} ({o.shareNumerator}/{o.shareDenominator}
                    )
                  </p>
                  <p className="list__meta">
                    {period(o.effectiveFrom, o.effectiveTo)}
                    {o.voidedAt ? ` · voided: ${o.voidReason}` : ''}
                  </p>
                </div>
              </li>
            ))}
            {tenancies.map((t) => (
              <li key={t.id} className="list__item">
                <div>
                  <p className="list__primary">
                    {t.occupants.find((x) => x.personId === person.id)?.isPrimary
                      ? 'Primary tenant'
                      : 'Tenant'}{' '}
                    of {unitLink(t.unitId, 'a unit')}
                  </p>
                  <p className="list__meta">
                    {period(t.startDate, t.endDate)}
                    {t.voidedAt ? ` · voided: ${t.voidReason}` : ''}
                  </p>
                </div>
              </li>
            ))}
            {household.map((h) => (
              <li key={h.id} className="list__item">
                <div>
                  <p className="list__primary">
                    Household member ({enumLabel(h.relationship)}) of {unitLink(h.unitId, 'a unit')}
                  </p>
                  <p className="list__meta">
                    {period(h.validFrom, h.validTo)}
                    {h.voidedAt ? ' · voided' : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <EmergencyContacts
        base={base}
        contacts={emergencyContacts}
        canManage={canManage}
        onChanged={detail.reload}
      />

      {canInvite && !person.linked ? (
        <InviteResident
          organisationId={organisationId}
          personId={person.id}
          hasEmail={person.email !== null}
        />
      ) : null}
    </>
  );
}

function Details({
  base,
  detail,
  canManage,
  onSaved,
}: {
  base: string;
  detail: PersonDetailResponse;
  canManage: boolean;
  onSaved: () => void;
}) {
  const { person } = detail;
  const save = useAction();
  const [editing, setEditing] = useState(false);

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    // An emptied optional field is sent as null, which clears it.
    const optional = (name: string) => String(form.get(name) ?? '').trim() || null;
    const ok = await save.run(() =>
      api.patch(base, {
        fullName: String(form.get('fullName') ?? ''),
        email: optional('email'),
        phone: optional('phone'),
        preferredLanguage: optional('preferredLanguage'),
      }),
    );
    if (ok) {
      setEditing(false);
      onSaved();
    }
  }

  const fields = fieldErrors(save.error);
  return (
    <Card
      title="Details"
      actions={
        canManage && !editing ? (
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit details
          </Button>
        ) : undefined
      }
    >
      {editing ? (
        <form className="form" onSubmit={onSave} noValidate aria-label="Edit resident details">
          {save.error ? <Alert>{errorMessage(save.error)}</Alert> : null}
          <TextField
            label="Full name"
            name="fullName"
            required
            maxLength={200}
            defaultValue={person.fullName}
            error={fields.fullName}
          />
          <TextField
            label="Email"
            name="email"
            type="email"
            defaultValue={person.email ?? ''}
            error={fields.email}
          />
          <TextField
            label="Phone"
            name="phone"
            type="tel"
            hint="International format, for example +923001234567"
            defaultValue={person.phone ?? ''}
            error={fields.phone}
          />
          <TextField
            label="Preferred language"
            name="preferredLanguage"
            hint="A language tag such as en or ur-PK"
            defaultValue={person.preferredLanguage ?? ''}
            error={fields.preferredLanguage}
          />
          <div className="form__actions">
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" busy={save.busy}>
              Save details
            </Button>
          </div>
        </form>
      ) : (
        <dl className="details">
          <div>
            <dt>Email</dt>
            <dd>{person.email ?? '—'}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>{person.phone ?? '—'}</dd>
          </div>
          <div>
            <dt>Preferred language</dt>
            <dd>{person.preferredLanguage ?? '—'}</dd>
          </div>
        </dl>
      )}
    </Card>
  );
}

function EmergencyContacts({
  base,
  contacts,
  canManage,
  onChanged,
}: {
  base: string;
  contacts: PersonDetailResponse['emergencyContacts'];
  canManage: boolean;
  onChanged: () => void;
}) {
  const add = useAction();
  const remove = useAction();

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const relationship = String(form.get('relationship') ?? '').trim();
    const ok = await add.run(() =>
      api.post(`${base}/emergency-contacts`, {
        name: String(form.get('name') ?? ''),
        phone: String(form.get('phone') ?? ''),
        ...(relationship ? { relationship } : {}),
      }),
    );
    if (ok) {
      formElement.reset();
      onChanged();
    }
  }

  const fields = fieldErrors(add.error);
  return (
    <Card title="Emergency contacts">
      {remove.error ? <Alert>{errorMessage(remove.error)}</Alert> : null}
      {contacts.length === 0 ? <p className="muted">No emergency contacts recorded.</p> : null}
      {contacts.length > 0 ? (
        <ul className="list" aria-label="Emergency contacts">
          {contacts.map((c) => (
            <li key={c.id} className="list__item">
              <div>
                <p className="list__primary">{c.name}</p>
                <p className="list__meta">
                  {[c.phone, c.relationship].filter(Boolean).join(' · ')}
                </p>
              </div>
              {canManage ? (
                <Button
                  variant="danger"
                  busy={remove.busy}
                  aria-label={`Remove emergency contact ${c.name}`}
                  onClick={() => {
                    if (!window.confirm(`Remove ${c.name} as an emergency contact?`)) return;
                    void remove
                      .run(() => api.delete(`${base}/emergency-contacts/${c.id}`))
                      .then((ok) => ok && onChanged());
                  }}
                >
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canManage ? (
        <form
          className="form form--inline"
          onSubmit={onAdd}
          noValidate
          aria-label="Add emergency contact"
        >
          {add.error ? <Alert>{errorMessage(add.error)}</Alert> : null}
          <TextField
            label="Contact name"
            name="name"
            required
            maxLength={200}
            error={fields.name}
          />
          <TextField label="Contact phone" name="phone" type="tel" required error={fields.phone} />
          <TextField label="Relationship (optional)" name="relationship" maxLength={60} />
          <Button type="submit" busy={add.busy}>
            Add contact
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

function InviteResident({
  organisationId,
  personId,
  hasEmail,
}: {
  organisationId: string;
  personId: string;
  hasEmail: boolean;
}) {
  const invite = useAction();
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);

  async function onInvite() {
    let response: CreateInvitationResponse | undefined;
    const ok = await invite.run(async () => {
      response = await api.post<CreateInvitationResponse>(
        `/organisations/${organisationId}/persons/${personId}/invitations`,
      );
    });
    if (ok && response) {
      setLink({
        email: response.invitation.email,
        url: invitationLink(window.location.origin, response.token),
      });
    }
  }

  return (
    <Card title="Resident app">
      <p className="muted">
        An invitation lets this resident sign in and see their home. It works once, for 7 days, and
        only for an account with their email address.
      </p>
      {!hasEmail ? (
        <Alert tone="info">Add an email address to this resident before inviting them.</Alert>
      ) : null}
      {invite.error ? <Alert>{errorMessage(invite.error)}</Alert> : null}
      {hasEmail && !link ? (
        <Button busy={invite.busy} onClick={() => void onInvite()}>
          Invite to the app
        </Button>
      ) : null}
      {link ? (
        <Alert tone="success" title={`Invitation created for ${link.email}`}>
          <p>Send this link to them. It will not be shown again.</p>
          <input
            className="field__input copy__input"
            readOnly
            value={link.url}
            aria-label="Resident invitation link"
            onFocus={(event) => event.currentTarget.select()}
          />
        </Alert>
      ) : null}
    </Card>
  );
}
