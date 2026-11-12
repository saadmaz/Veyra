'use client';

import type {
  CreateInvitationResponse,
  InvitationDto,
  MembershipDto,
  MyUnitDto,
  OrganisationDetailResponse,
  Paginated,
  PropertyDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import {
  errorMessage,
  fieldErrors,
  ORGANISATION_ROLES,
  residentRoleLabel,
  roleLabel,
} from '@/lib/messages';
import { invitationLink } from '@/lib/navigation';
import { useApiQuery } from '@/lib/use-api';

export default function OrganisationPage() {
  const { organisationId } = useParams<{ organisationId: string }>();
  const organisation = useApiQuery<OrganisationDetailResponse>(
    `/organisations/${encodeURIComponent(organisationId)}`,
  );

  useEffect(() => {
    if (organisation.status === 'success') {
      document.title = `${organisation.data.name} · VEYRA Console`;
    }
  }, [organisation]);

  if (organisation.status === 'loading') return <LoadingState label="Loading organisation" />;
  if (organisation.status === 'error') {
    if (organisation.error instanceof ApiRequestError && organisation.error.status === 404) {
      return (
        <EmptyState title="Organisation not found">
          It does not exist, or you are not a member of it.
        </EmptyState>
      );
    }
    return <ErrorState error={organisation.error} onRetry={organisation.reload} />;
  }

  const org = organisation.data;
  // The API enforces every permission; these only decide what to show.
  const can = (permission: string) => org.permissions.includes(permission);

  return (
    <>
      <div className="page__header">
        <h1>{org.name}</h1>
        {org.status !== 'ACTIVE' ? <StatusBadge status={org.status} /> : null}
      </div>
      {org.status === 'SUSPENDED' ? (
        <Alert tone="info">
          This organisation is suspended. You can view it, but not change it.
        </Alert>
      ) : null}

      <Card title="Overview">
        <dl className="details">
          <div>
            <dt>Web address</dt>
            <dd>{org.slug}</dd>
          </div>
          <div>
            <dt>Country</dt>
            <dd>{org.countryCode}</dd>
          </div>
          <div>
            <dt>Currency</dt>
            <dd>{org.defaultCurrency}</dd>
          </div>
          <div>
            <dt>Time zone</dt>
            <dd>{org.defaultTimeZone.replaceAll('_', ' ')}</dd>
          </div>
        </dl>
      </Card>

      <YourHomes organisationId={org.id} />
      <Properties organisationId={org.id} canCreate={can('organisation.property.create')} />
      {can('organisation.vendor.read') ? (
        <Card title="Vendors">
          <p className="muted">
            Outside contractors, their trades and their insurance and licences.
          </p>
          <div className="form__actions">
            <ButtonLink href={`/organisations/${org.id}/vendors`}>Open vendors</ButtonLink>
          </div>
        </Card>
      ) : null}
      {can('organisation.member.read') ? <Members organisationId={org.id} /> : null}
      {can('organisation.member.invite') ? <Invitations organisationId={org.id} /> : null}
    </>
  );
}

/** Units the caller owns, rents or lives in today. Shown only when there are any. */
function YourHomes({ organisationId }: { organisationId: string }) {
  const homes = useApiQuery<{ data: MyUnitDto[] }>(`/organisations/${organisationId}/my-units`);
  if (homes.status === 'loading') return null;
  if (homes.status === 'error') return <ErrorState error={homes.error} onRetry={homes.reload} />;
  if (homes.data.data.length === 0) return null;
  return (
    <Card title="Your homes">
      <ul className="list" aria-label="Your homes">
        {homes.data.data.map((home) => (
          <li key={home.unitId} className="list__item">
            <div>
              <Link
                href={`/organisations/${organisationId}/properties/${home.propertyId}/units/${home.unitId}`}
                className="list__link"
              >
                Unit {home.unitNumber}
              </Link>
              <p className="list__meta">
                {[home.propertyName, home.buildingName].filter(Boolean).join(' · ')} ·{' '}
                {home.roles.map(residentRoleLabel).join(', ')}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Every member sees the properties their grants reach; the API filters the list. */
function Properties({ organisationId, canCreate }: { organisationId: string; canCreate: boolean }) {
  const properties = useApiQuery<Paginated<PropertyDto>>(
    `/organisations/${organisationId}/properties?limit=200`,
  );
  // Residents without staff roles have no properties to list: no empty card for them.
  if (!canCreate && properties.status === 'success' && properties.data.data.length === 0) {
    return null;
  }
  const addLink = canCreate ? (
    <ButtonLink href={`/organisations/${organisationId}/properties/new`}>Add property</ButtonLink>
  ) : undefined;
  return (
    <Card title="Properties" actions={addLink}>
      {properties.status === 'loading' ? <LoadingState label="Loading properties" /> : null}
      {properties.status === 'error' ? (
        <ErrorState error={properties.error} onRetry={properties.reload} />
      ) : null}
      {properties.status === 'success' && properties.data.data.length === 0 ? (
        <p className="muted">
          {canCreate
            ? 'No properties yet. Add the first one.'
            : 'You have no properties assigned yet.'}
        </p>
      ) : null}
      {properties.status === 'success' && properties.data.data.length > 0 ? (
        <ul className="list" aria-label="Properties">
          {properties.data.data.map((property) => (
            <li key={property.id} className="list__item">
              <div>
                <Link
                  href={`/organisations/${organisationId}/properties/${property.id}`}
                  className="list__link"
                >
                  {property.name}
                </Link>
                <p className="list__meta">
                  {property.code} · {property.city}
                </p>
              </div>
              {property.status !== 'ACTIVE' ? <StatusBadge status={property.status} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function Members({ organisationId }: { organisationId: string }) {
  const members = useApiQuery<Paginated<MembershipDto>>(
    `/organisations/${organisationId}/memberships?limit=200`,
  );
  return (
    <Card title="Members">
      {members.status === 'loading' ? <LoadingState label="Loading members" /> : null}
      {members.status === 'error' ? (
        <ErrorState error={members.error} onRetry={members.reload} />
      ) : null}
      {members.status === 'success' ? (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Members and their roles</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {members.data.data.map((member) => (
                <tr key={member.id}>
                  <td>{member.displayName}</td>
                  <td>{member.email}</td>
                  <td>{roleLabel(member.role)}</td>
                  <td>
                    <StatusBadge status={member.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function Invitations({ organisationId }: { organisationId: string }) {
  const invitations = useApiQuery<Paginated<InvitationDto>>(
    `/organisations/${organisationId}/invitations?limit=200`,
  );
  const [issued, setIssued] = useState<{ email: string; link: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);

  async function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setError(null);
    setIssued(null);
    setCopied(false);
    try {
      const response = await api.post<CreateInvitationResponse>(
        `/organisations/${organisationId}/invitations`,
        { email: String(form.get('email') ?? ''), role: String(form.get('role') ?? '') },
      );
      setIssued({
        email: response.invitation.email,
        link: invitationLink(window.location.origin, response.token),
      });
      formElement.reset();
      invitations.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(invitation: InvitationDto) {
    if (!window.confirm(`Withdraw the invitation for ${invitation.email}?`)) return;
    setActionError(null);
    try {
      await api.post(`/organisations/${organisationId}/invitations/${invitation.id}/revoke`);
      invitations.reload();
    } catch (caught) {
      setActionError(caught);
    }
  }

  const fields = fieldErrors(error);
  const pending =
    invitations.status === 'success'
      ? invitations.data.data.filter((invitation) => invitation.status === 'PENDING')
      : [];

  return (
    <Card title="Invitations">
      <form className="form form--inline" onSubmit={onInvite} noValidate>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        <TextField label="Email" name="email" type="email" required error={fields.email} />
        <SelectField label="Role" name="role" defaultValue="FINANCE_OFFICER" error={fields.role}>
          {ORGANISATION_ROLES.map((role) => (
            <option key={role} value={role}>
              {roleLabel(role)}
            </option>
          ))}
        </SelectField>
        <Button type="submit" busy={busy}>
          Invite
        </Button>
      </form>

      {issued ? (
        <Alert tone="success" title={`Invitation created for ${issued.email}`}>
          <p>
            Send this link to them. It works once, for 7 days, and only for an account with that
            email address. It will not be shown again.
          </p>
          <div className="copy">
            <input
              className="field__input copy__input"
              readOnly
              value={issued.link}
              aria-label="Invitation link"
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(issued.link).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </div>
        </Alert>
      ) : null}

      <h3 className="section-title">Waiting to be accepted</h3>
      {actionError ? <Alert>{errorMessage(actionError)}</Alert> : null}
      {invitations.status === 'loading' ? <LoadingState label="Loading invitations" /> : null}
      {invitations.status === 'error' ? (
        <ErrorState error={invitations.error} onRetry={invitations.reload} />
      ) : null}
      {invitations.status === 'success' && pending.length === 0 ? (
        <p className="muted">No pending invitations.</p>
      ) : null}
      {pending.length > 0 ? (
        <ul className="list" aria-label="Pending invitations">
          {pending.map((invitation) => (
            <li key={invitation.id} className="list__item">
              <div>
                <p className="list__primary">{invitation.email}</p>
                <p className="list__meta">
                  {roleLabel(invitation.role)} · expires{' '}
                  {new Date(invitation.expiresAt).toLocaleDateString()}
                </p>
              </div>
              <Button variant="danger" onClick={() => void withdraw(invitation)}>
                Withdraw
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
