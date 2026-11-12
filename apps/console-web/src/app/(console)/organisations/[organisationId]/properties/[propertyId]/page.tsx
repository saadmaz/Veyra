'use client';

import type {
  BuildingDto,
  CommonAreaDto,
  CreateInvitationResponse,
  OrganisationDetailResponse,
  Paginated,
  PropertyDetailResponse,
  UnitDto,
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
  COMMON_AREA_TYPES,
  enumLabel,
  errorMessage,
  fieldErrors,
  UNIT_TYPES,
} from '@/lib/messages';
import { invitationLink } from '@/lib/navigation';
import { confirmArchive, useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';

export default function PropertyPage() {
  const { organisationId, propertyId } = useParams<{
    organisationId: string;
    propertyId: string;
  }>();
  const base = `/organisations/${organisationId}/properties/${propertyId}`;
  const property = useApiQuery<PropertyDetailResponse>(base);
  // Organisation-level permissions decide whether the caller may invite a property manager.
  const organisation = useApiQuery<OrganisationDetailResponse>(`/organisations/${organisationId}`);
  const lifecycle = useAction();

  useEffect(() => {
    if (property.status === 'success') document.title = `${property.data.name} · VEYRA Console`;
  }, [property]);

  if (property.status === 'loading') return <LoadingState label="Loading property" />;
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
  // The API enforces every permission; these only decide which controls to show.
  const can = (permission: string) => p.permissions.includes(permission);
  const canManage = can('property.structure.manage');
  const canInvite =
    organisation.status === 'success' &&
    organisation.data.permissions.includes('organisation.member.invite');

  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href={`/organisations/${organisationId}`}>
          {organisation.status === 'success' ? organisation.data.name : 'Organisation'}
        </Link>
      </nav>
      <div className="page__header">
        <h1>{p.name}</h1>
        <div className="form__actions">
          <StatusBadge status={p.status} />
          {can('property.lifecycle.manage') && p.status === 'ONBOARDING' ? (
            <Button
              busy={lifecycle.busy}
              onClick={() =>
                void lifecycle
                  .run(() => api.post(`${base}/activate`))
                  .then((ok) => ok && property.reload())
              }
            >
              Activate property
            </Button>
          ) : null}
          {can('property.lifecycle.manage') && p.status !== 'ARCHIVED' ? (
            <Button
              variant="danger"
              busy={lifecycle.busy}
              onClick={() => {
                if (!confirmArchive(`${p.name} and everything in it`)) return;
                void lifecycle
                  .run(() => api.post(`${base}/archive`))
                  .then((ok) => ok && property.reload());
              }}
            >
              Archive property
            </Button>
          ) : null}
        </div>
      </div>
      {lifecycle.error ? <Alert>{errorMessage(lifecycle.error)}</Alert> : null}
      {p.status === 'ARCHIVED' ? (
        <Alert tone="info">
          This property is archived. You can view it, but nothing can be changed.
        </Alert>
      ) : null}
      {p.status === 'ONBOARDING' ? (
        <Alert tone="info">
          This property is being set up. Activate it when its structure is ready.
        </Alert>
      ) : null}

      <Card title="Overview">
        <dl className="details">
          <div>
            <dt>Code</dt>
            <dd>{p.code}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>{enumLabel(p.type)}</dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd>
              {[p.addressLine1, p.addressLine2, p.city, p.region, p.postalCode]
                .filter(Boolean)
                .join(', ')}
            </dd>
          </div>
          <div>
            <dt>Country and currency</dt>
            <dd>
              {p.countryCode} · {p.currency}
            </dd>
          </div>
          <div>
            <dt>Time zone</dt>
            <dd>{p.timeZone.replaceAll('_', ' ')}</dd>
          </div>
        </dl>
      </Card>

      {can('property.resident.read') ? (
        <Card title="Residents">
          <p className="muted">
            Owners, tenants and household members. Open a unit below to record who owns it or lives
            there.
          </p>
          <div className="form__actions">
            <ButtonLink href={`${base}/residents`} variant="secondary">
              View residents
            </ButtonLink>
          </div>
        </Card>
      ) : null}
      {can('property.visitor.check_in') || can('property.visitor.read') ? (
        <Card title="Visitors and gate">
          <p className="muted">
            Residents register their visitors on their unit page. Security staff check passes at the
            gate.
          </p>
          <div className="form__actions">
            {can('property.visitor.check_in') ? (
              <ButtonLink href={`${base}/gate`}>Open the gate screen</ButtonLink>
            ) : null}
            {can('property.visitor.read') ? (
              <ButtonLink href={`${base}/visitors`} variant="secondary">
                Visit log
              </ButtonLink>
            ) : null}
          </div>
        </Card>
      ) : null}
      {can('property.maintenance.read') || can('property.maintenance.work') ? (
        <Card title="Maintenance">
          <p className="muted">
            Problems reported by residents and staff, work orders, costs and response targets.
          </p>
          <div className="form__actions">
            {can('property.maintenance.read') ? (
              <ButtonLink href={`${base}/maintenance`}>Open maintenance</ButtonLink>
            ) : null}
            {can('property.maintenance.work') ? (
              <ButtonLink href={`${base}/my-work`} variant="secondary">
                My work
              </ButtonLink>
            ) : null}
          </div>
        </Card>
      ) : null}
      {can('property.announcement.read') || can('property.document.read') ? (
        <Card title="Communications">
          <p className="muted">
            Announcements to residents and staff, and the property's documents.
          </p>
          <div className="form__actions">
            {can('property.announcement.read') ? (
              <ButtonLink href={`${base}/announcements`}>Announcements</ButtonLink>
            ) : null}
            {can('property.document.read') ? (
              <ButtonLink href={`${base}/documents`} variant="secondary">
                Documents
              </ButtonLink>
            ) : null}
          </div>
        </Card>
      ) : null}
      {can('property.maintenance.read') ? (
        <Card title="Assets">
          <p className="muted">
            Equipment, its warranty and service history, and preventive maintenance.
          </p>
          <div className="form__actions">
            <ButtonLink href={`${base}/assets`}>Open assets</ButtonLink>
          </div>
        </Card>
      ) : null}
      {can('property.staff.read') || can('property.staff.work') ? (
        <Card title="Staff">
          <p className="muted">Departments, shifts and handovers, and checklists.</p>
          <div className="form__actions">
            {can('property.staff.read') ? (
              <ButtonLink href={`${base}/staff`}>Plan staff</ButtonLink>
            ) : null}
            {can('property.staff.work') ? (
              <ButtonLink href={`${base}/my-shifts`} variant="secondary">
                My shifts
              </ButtonLink>
            ) : null}
          </div>
        </Card>
      ) : null}
      {can('property.facility.read') ? (
        <Card title="Facilities">
          <p className="muted">
            Bookable common areas, opening hours, closures and residents' bookings.
          </p>
          <div className="form__actions">
            <ButtonLink href={`${base}/facilities`}>Open facilities</ButtonLink>
          </div>
        </Card>
      ) : null}
      {can('property.finance.read') ? (
        <Card title="Finance">
          <p className="muted">
            Charges, invoices, payments and receipts, approvals and reports, in {p.currency}.
          </p>
          <div className="form__actions">
            <ButtonLink href={`${base}/finance`} variant="secondary">
              Open finance
            </ButtonLink>
          </div>
        </Card>
      ) : null}
      {can('property.structure.read') ? (
        <>
          <Buildings base={base} canManage={canManage} />
          <Units base={base} canManage={canManage} />
          <CommonAreas base={base} canManage={canManage} />
        </>
      ) : null}
      {canInvite && p.status !== 'ARCHIVED' ? (
        <InviteManager organisationId={organisationId} propertyId={propertyId} />
      ) : null}
    </>
  );
}

function Buildings({ base, canManage }: { base: string; canManage: boolean }) {
  const buildings = useApiQuery<Paginated<BuildingDto>>(`${base}/buildings?limit=200`);
  const create = useAction();
  const archive = useAction();

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const ok = await create.run(() =>
      api.post(`${base}/buildings`, {
        name: String(form.get('name') ?? ''),
        code: String(form.get('code') ?? ''),
      }),
    );
    if (ok) {
      formElement.reset();
      buildings.reload();
    }
  }

  const fields = fieldErrors(create.error);
  return (
    <Card title="Buildings">
      {archive.error ? <Alert>{errorMessage(archive.error)}</Alert> : null}
      {buildings.status === 'loading' ? <LoadingState label="Loading buildings" /> : null}
      {buildings.status === 'error' ? (
        <ErrorState error={buildings.error} onRetry={buildings.reload} />
      ) : null}
      {buildings.status === 'success' && buildings.data.data.length === 0 ? (
        <p className="muted">
          No buildings yet. Villas and other stand-alone units can be added without one.
        </p>
      ) : null}
      {buildings.status === 'success' && buildings.data.data.length > 0 ? (
        <ul className="list" aria-label="Buildings">
          {buildings.data.data.map((b) => (
            <li key={b.id} className="list__item">
              <div>
                <Link href={`${base}/buildings/${b.id}`} className="list__link">
                  {b.name}
                </Link>
                <p className="list__meta">{b.code}</p>
              </div>
              {canManage ? (
                <Button
                  variant="danger"
                  busy={archive.busy}
                  onClick={() => {
                    if (!confirmArchive(b.name)) return;
                    void archive
                      .run(() => api.post(`${base}/buildings/${b.id}/archive`))
                      .then((ok) => ok && buildings.reload());
                  }}
                >
                  Archive
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canManage ? (
        <form
          className="form form--inline"
          onSubmit={onCreate}
          noValidate
          aria-label="Add building"
        >
          {create.error ? <Alert>{errorMessage(create.error)}</Alert> : null}
          <TextField
            label="Building name"
            name="name"
            required
            maxLength={120}
            error={fields.name}
          />
          <TextField
            label="Building code"
            name="code"
            required
            maxLength={20}
            hint="For example A or TOWER-1"
            error={fields.code}
          />
          <Button type="submit" busy={create.busy}>
            Add building
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

function Units({ base, canManage }: { base: string; canManage: boolean }) {
  const units = useApiQuery<Paginated<UnitDto>>(`${base}/units?limit=200`);
  const buildings = useApiQuery<Paginated<BuildingDto>>(`${base}/buildings?limit=200`);
  const create = useAction();
  const archive = useAction();
  const buildingName = (id: string | null) =>
    id === null
      ? 'No building'
      : buildings.status === 'success'
        ? (buildings.data.data.find((b) => b.id === id)?.name ?? 'Building')
        : '…';

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const buildingId = String(form.get('buildingId') ?? '');
    const areaSqm = String(form.get('areaSqm') ?? '').trim();
    const ok = await create.run(() =>
      api.post(`${base}/units`, {
        number: String(form.get('number') ?? ''),
        type: String(form.get('type') ?? ''),
        ...(buildingId ? { buildingId } : {}),
        // Sent as a string: the API never accepts areas as floating-point numbers.
        ...(areaSqm ? { areaSqm } : {}),
      }),
    );
    if (ok) {
      formElement.reset();
      units.reload();
    }
  }

  const fields = fieldErrors(create.error);
  return (
    <Card title="Units">
      {archive.error ? <Alert>{errorMessage(archive.error)}</Alert> : null}
      {units.status === 'loading' ? <LoadingState label="Loading units" /> : null}
      {units.status === 'error' ? <ErrorState error={units.error} onRetry={units.reload} /> : null}
      {units.status === 'success' && units.data.data.length === 0 ? (
        <p className="muted">No units yet.</p>
      ) : null}
      {units.status === 'success' && units.data.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Units of this property</caption>
            <thead>
              <tr>
                <th scope="col">Unit</th>
                <th scope="col">Type</th>
                <th scope="col">Building</th>
                <th scope="col">Area (m²)</th>
                {canManage ? (
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {units.data.data.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link href={`${base}/units/${u.id}`} aria-label={`Unit ${u.number}`}>
                      {u.number}
                    </Link>
                  </td>
                  <td>{enumLabel(u.type)}</td>
                  <td>{buildingName(u.buildingId)}</td>
                  <td>{u.areaSqm ?? '—'}</td>
                  {canManage ? (
                    <td>
                      <Button
                        variant="danger"
                        busy={archive.busy}
                        aria-label={`Archive unit ${u.number}`}
                        onClick={() => {
                          if (!confirmArchive(`unit ${u.number}`)) return;
                          void archive
                            .run(() => api.post(`${base}/units/${u.id}/archive`))
                            .then((ok) => ok && units.reload());
                        }}
                      >
                        Archive
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {canManage ? (
        <form className="form form--inline" onSubmit={onCreate} noValidate aria-label="Add unit">
          {create.error ? <Alert>{errorMessage(create.error)}</Alert> : null}
          <TextField
            label="Unit number"
            name="number"
            required
            maxLength={40}
            error={fields.number}
          />
          <SelectField label="Unit type" name="type" defaultValue="APARTMENT" error={fields.type}>
            {UNIT_TYPES.map((type) => (
              <option key={type} value={type}>
                {enumLabel(type)}
              </option>
            ))}
          </SelectField>
          <SelectField label="Building" name="buildingId" defaultValue="" error={fields.buildingId}>
            <option value="">No building</option>
            {buildings.status === 'success'
              ? buildings.data.data.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))
              : null}
          </SelectField>
          <TextField
            label="Area in m² (optional)"
            name="areaSqm"
            inputMode="decimal"
            maxLength={12}
            error={fields.areaSqm}
          />
          <Button type="submit" busy={create.busy}>
            Add unit
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

function CommonAreas({ base, canManage }: { base: string; canManage: boolean }) {
  const areas = useApiQuery<Paginated<CommonAreaDto>>(`${base}/common-areas?limit=200`);
  const create = useAction();
  const archive = useAction();

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const ok = await create.run(() =>
      api.post(`${base}/common-areas`, {
        name: String(form.get('name') ?? ''),
        type: String(form.get('type') ?? ''),
      }),
    );
    if (ok) {
      formElement.reset();
      areas.reload();
    }
  }

  const fields = fieldErrors(create.error);
  return (
    <Card title="Common areas">
      {archive.error ? <Alert>{errorMessage(archive.error)}</Alert> : null}
      {areas.status === 'loading' ? <LoadingState label="Loading common areas" /> : null}
      {areas.status === 'error' ? <ErrorState error={areas.error} onRetry={areas.reload} /> : null}
      {areas.status === 'success' && areas.data.data.length === 0 ? (
        <p className="muted">No common areas yet.</p>
      ) : null}
      {areas.status === 'success' && areas.data.data.length > 0 ? (
        <ul className="list" aria-label="Common areas">
          {areas.data.data.map((a) => (
            <li key={a.id} className="list__item">
              <div>
                <p className="list__primary">{a.name}</p>
                <p className="list__meta">{enumLabel(a.type)}</p>
              </div>
              {canManage ? (
                <Button
                  variant="danger"
                  busy={archive.busy}
                  aria-label={`Archive ${a.name}`}
                  onClick={() => {
                    if (!confirmArchive(a.name)) return;
                    void archive
                      .run(() => api.post(`${base}/common-areas/${a.id}/archive`))
                      .then((ok) => ok && areas.reload());
                  }}
                >
                  Archive
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canManage ? (
        <form
          className="form form--inline"
          onSubmit={onCreate}
          noValidate
          aria-label="Add common area"
        >
          {create.error ? <Alert>{errorMessage(create.error)}</Alert> : null}
          <TextField
            label="Common area name"
            name="name"
            required
            maxLength={120}
            error={fields.name}
          />
          <SelectField
            label="Common area type"
            name="type"
            defaultValue="LOBBY"
            error={fields.type}
          >
            {COMMON_AREA_TYPES.map((type) => (
              <option key={type} value={type}>
                {enumLabel(type)}
              </option>
            ))}
          </SelectField>
          <Button type="submit" busy={create.busy}>
            Add common area
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

function InviteManager({
  organisationId,
  propertyId,
}: {
  organisationId: string;
  propertyId: string;
}) {
  const invite = useAction();
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);

  async function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const email = String(new FormData(formElement).get('email') ?? '');
    let response: CreateInvitationResponse | undefined;
    const ok = await invite.run(async () => {
      response = await api.post<CreateInvitationResponse>(
        `/organisations/${organisationId}/invitations`,
        {
          email,
          role: 'PROPERTY_MANAGER',
          propertyId,
        },
      );
    });
    if (ok && response) {
      setLink({
        email: response.invitation.email,
        url: invitationLink(window.location.origin, response.token),
      });
      formElement.reset();
    }
  }

  return (
    <Card title="Property managers">
      <p className="muted">
        A property manager runs this property only: its settings, buildings and units.
      </p>
      <form
        className="form form--inline"
        onSubmit={onInvite}
        noValidate
        aria-label="Invite a property manager"
      >
        {invite.error ? <Alert>{errorMessage(invite.error)}</Alert> : null}
        <TextField
          label="Manager's email"
          name="email"
          type="email"
          required
          error={fieldErrors(invite.error).email}
        />
        <Button type="submit" busy={invite.busy}>
          Invite manager
        </Button>
      </form>
      {link ? (
        <Alert tone="success" title={`Invitation created for ${link.email}`}>
          <p>Send this link to them. It works once, for 7 days, and only for that email address.</p>
          <input
            className="field__input copy__input"
            readOnly
            value={link.url}
            aria-label="Manager invitation link"
          />
        </Alert>
      ) : null}
    </Card>
  );
}
