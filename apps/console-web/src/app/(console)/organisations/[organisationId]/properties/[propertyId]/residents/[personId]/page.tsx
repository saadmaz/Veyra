'use client';

import type {
  CreateInvitationResponse,
  OrganisationDetailResponse,
  Paginated,
  PersonDetailResponse,
  PersonDto,
  PropertyDetailResponse,
  UnitDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { PeriodBadge } from '@/components/residents';
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
import {
  formatPeriod,
  formatShare,
  type PeriodStatus,
  periodStatus,
  todayIn,
} from '@/lib/residents';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';

/** One resident as seen from this property: profile, records on its units, emergency contacts. */
export default function ResidentPage() {
  const { organisationId, propertyId, personId } = useParams<{
    organisationId: string;
    propertyId: string;
    personId: string;
  }>();
  const base = `/organisations/${organisationId}/properties/${propertyId}`;
  const property = useApiQuery<PropertyDetailResponse>(base);
  const canRead =
    property.status === 'success' && property.data.permissions.includes('property.resident.read');
  const detail = useApiQuery<PersonDetailResponse>(canRead ? `${base}/persons/${personId}` : null);
  // Inviting a resident to the app is an organisation-level permission.
  const organisation = useApiQuery<OrganisationDetailResponse>(`/organisations/${organisationId}`);

  useEffect(() => {
    if (detail.status === 'success')
      document.title = `${detail.data.person.fullName} · VEYRA Console`;
  }, [detail]);

  if (property.status === 'loading') return <LoadingState label="Loading resident" />;
  if (property.status === 'error') {
    if (property.error instanceof ApiRequestError && property.error.status === 404) {
      return (
        <EmptyState title="Property not found">
          It does not exist, or it is not one of the properties assigned to you.
        </EmptyState>
      );
    }
    return <ErrorState error={property.error} onRetry={property.reload} />;
  }
  const p = property.data;
  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link href={base}>{p.name}</Link> / <Link href={`${base}/residents`}>Residents</Link>
    </nav>
  );
  if (!canRead) {
    return (
      <>
        {crumbs}
        <EmptyState title="You cannot view residents">
          Resident details are available to organisation admins and the property's managers.
        </EmptyState>
      </>
    );
  }
  if (detail.status === 'loading') return <LoadingState label="Loading resident" />;
  if (detail.status === 'error') {
    if (detail.error instanceof ApiRequestError && detail.error.status === 404) {
      return (
        <>
          {crumbs}
          <EmptyState title="Resident not found">
            They are not a resident of this property, or the profile does not exist.
          </EmptyState>
        </>
      );
    }
    return <ErrorState error={detail.error} onRetry={detail.reload} />;
  }

  const { person } = detail.data;
  const canManage =
    p.permissions.includes('property.resident.manage') && person.status === 'ACTIVE';
  const canInvite =
    organisation.status === 'success' &&
    organisation.data.permissions.includes('organisation.member.invite') &&
    person.status === 'ACTIVE' &&
    !person.linked;

  return (
    <>
      {crumbs}
      <div className="page__header">
        <h1>{person.fullName}</h1>
        {person.status === 'ARCHIVED' ? <StatusBadge status={person.status} /> : null}
      </div>
      <Profile base={base} person={person} canManage={canManage} onSaved={detail.reload} />
      {canInvite ? <InviteResident organisationId={organisationId} person={person} /> : null}
      <Records base={base} detail={detail.data} today={todayIn(p.timeZone)} />
      <EmergencyContacts
        base={base}
        detail={detail.data}
        canManage={canManage}
        onChanged={detail.reload}
      />
    </>
  );
}

function Profile({
  base,
  person,
  canManage,
  onSaved,
}: {
  base: string;
  person: PersonDto;
  canManage: boolean;
  onSaved: () => void;
}) {
  const save = useAction();
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    // Only changed fields are sent (the audit trail records which ones); empty clears a field.
    const changes: Record<string, string | null> = {};
    if (text('fullName') !== person.fullName) changes.fullName = text('fullName');
    for (const key of ['email', 'phone', 'preferredLanguage'] as const) {
      const value = text(key) || null;
      if (value !== person[key]) changes[key] = value;
    }
    if (Object.keys(changes).length === 0) {
      setEditing(false);
      return;
    }
    const ok = await save.run(() => api.patch(`${base}/persons/${person.id}`, changes));
    if (ok) {
      setEditing(false);
      setNotice('Profile saved.');
      onSaved();
    }
  }

  const fields = fieldErrors(save.error);
  return (
    <Card
      title="Profile"
      actions={
        canManage && !editing ? (
          <Button
            variant="secondary"
            onClick={() => {
              setNotice(null);
              setEditing(true);
            }}
          >
            Edit profile
          </Button>
        ) : undefined
      }
    >
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {editing ? (
        <form
          className="form form--inline"
          onSubmit={onSubmit}
          noValidate
          aria-label="Edit profile"
        >
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
            maxLength={254}
            defaultValue={person.email ?? ''}
            hint="Leave empty to remove"
            error={fields.email}
          />
          <TextField
            label="Phone"
            name="phone"
            type="tel"
            maxLength={20}
            defaultValue={person.phone ?? ''}
            hint="International format, e.g. +923001234567"
            error={fields.phone}
          />
          <TextField
            label="Language"
            name="preferredLanguage"
            maxLength={35}
            defaultValue={person.preferredLanguage ?? ''}
            hint="For example en or ur-PK"
            error={fields.preferredLanguage}
          />
          <div className="form__actions">
            <Button type="submit" busy={save.busy}>
              Save profile
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                save.clearError();
                setEditing(false);
              }}
            >
              Cancel
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
            <dt>Language</dt>
            <dd>{person.preferredLanguage ?? '—'}</dd>
          </div>
          <div>
            <dt>App access</dt>
            <dd>{person.linked ? 'Linked to an account' : 'Not linked'}</dd>
          </div>
        </dl>
      )}
    </Card>
  );
}

function InviteResident({ organisationId, person }: { organisationId: string; person: PersonDto }) {
  const invite = useAction();
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);

  async function onInvite() {
    let response: CreateInvitationResponse | undefined;
    const ok = await invite.run(async () => {
      response = await api.post<CreateInvitationResponse>(
        `/organisations/${organisationId}/persons/${person.id}/invitations`,
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
    <Card title="App access">
      <p className="muted">
        An invitation lets {person.fullName} sign in and see their units. It is sent to their email
        address and works only for that address.
      </p>
      {invite.error ? <Alert>{errorMessage(invite.error)}</Alert> : null}
      {person.email ? (
        <div className="form__actions">
          <Button busy={invite.busy} onClick={() => void onInvite()}>
            Create invitation link
          </Button>
        </div>
      ) : (
        <p className="muted">Add an email address to the profile first.</p>
      )}
      {link ? (
        <Alert tone="success" title={`Invitation created for ${link.email}`}>
          <p>Send this link to them. It works once, for 7 days, and only for that email address.</p>
          <input
            className="field__input copy__input"
            readOnly
            value={link.url}
            aria-label="Resident invitation link"
          />
        </Alert>
      ) : null}
    </Card>
  );
}

interface RecordRow {
  key: string;
  unitId: string;
  role: string;
  detail: string;
  from: string;
  to: string | null;
  status: PeriodStatus;
}

function Records({
  base,
  detail,
  today,
}: {
  base: string;
  detail: PersonDetailResponse;
  today: string;
}) {
  // Unit numbers for the records (active units; archived ones show as such).
  const units = useApiQuery<Paginated<UnitDto>>(`${base}/units?limit=200`);
  const unitNumber = (id: string) =>
    units.status === 'success'
      ? (units.data.data.find((u) => u.id === id)?.number ?? 'Archived unit')
      : '…';

  const rows: RecordRow[] = [
    ...detail.ownerships.map((o) => ({
      key: `o-${o.id}`,
      unitId: o.unitId,
      role: 'Owner',
      detail: `Share: ${formatShare(o)}`,
      from: o.effectiveFrom,
      to: o.effectiveTo,
      status: periodStatus(o.effectiveFrom, o.effectiveTo, o.voidedAt, today),
    })),
    ...detail.tenancies.map((t) => ({
      key: `t-${t.id}`,
      unitId: t.unitId,
      role: 'Tenant',
      detail: t.occupants.find((o) => o.personId === detail.person.id)?.isPrimary
        ? 'Primary tenant'
        : 'Co-tenant',
      from: t.startDate,
      to: t.endDate,
      status: periodStatus(t.startDate, t.endDate, t.voidedAt, today),
    })),
    ...detail.household.map((h) => ({
      key: `h-${h.id}`,
      unitId: h.unitId,
      role: 'Household member',
      detail: enumLabel(h.relationship),
      from: h.validFrom,
      to: h.validTo,
      status: periodStatus(h.validFrom, h.validTo, h.voidedAt, today),
    })),
  ].sort((a, b) => (a.from < b.from ? 1 : -1));

  return (
    <Card title="Units and records">
      {rows.length === 0 ? (
        <p className="muted">
          No records at this property yet. Open a unit to make them an owner, tenant or household
          member.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Records of {detail.person.fullName}</caption>
            <thead>
              <tr>
                <th scope="col">Unit</th>
                <th scope="col">Role</th>
                <th scope="col">Period</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <Link href={`${base}/units/${r.unitId}`}>{unitNumber(r.unitId)}</Link>
                  </td>
                  <td>
                    {r.role} <span className="muted">({r.detail})</span>
                  </td>
                  <td>{formatPeriod(r.from, r.to)}</td>
                  <td>
                    <PeriodBadge status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function EmergencyContacts({
  base,
  detail,
  canManage,
  onChanged,
}: {
  base: string;
  detail: PersonDetailResponse;
  canManage: boolean;
  onChanged: () => void;
}) {
  const add = useAction();
  const remove = useAction();
  const personPath = `${base}/persons/${detail.person.id}`;

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const relationship = String(form.get('relationship') ?? '').trim();
    const ok = await add.run(() =>
      api.post(`${personPath}/emergency-contacts`, {
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
  const contacts = detail.emergencyContacts;
  return (
    <Card title="Emergency contacts">
      {remove.error ? <Alert>{errorMessage(remove.error)}</Alert> : null}
      {contacts.length === 0 ? <p className="muted">No emergency contacts.</p> : null}
      {contacts.length > 0 ? (
        <ul className="list" aria-label="Emergency contacts">
          {contacts.map((c) => (
            <li key={c.id} className="list__item">
              <div>
                <p className="list__primary">{c.name}</p>
                <p className="list__meta">
                  {[c.relationship, c.phone].filter(Boolean).join(' · ')}
                </p>
              </div>
              {canManage ? (
                <Button
                  variant="danger"
                  busy={remove.busy}
                  aria-label={`Remove emergency contact ${c.name}`}
                  onClick={() => {
                    if (!window.confirm(`Remove ${c.name} from the emergency contacts?`)) return;
                    void remove
                      .run(() => api.delete(`${personPath}/emergency-contacts/${c.id}`))
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
            autoComplete="off"
            error={fields.name}
          />
          <TextField
            label="Contact phone"
            name="phone"
            type="tel"
            required
            maxLength={20}
            hint="International format, e.g. +923001234567"
            autoComplete="off"
            error={fields.phone}
          />
          <TextField
            label="Relationship (optional)"
            name="relationship"
            maxLength={60}
            error={fields.relationship}
          />
          <Button type="submit" busy={add.busy}>
            Add contact
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
