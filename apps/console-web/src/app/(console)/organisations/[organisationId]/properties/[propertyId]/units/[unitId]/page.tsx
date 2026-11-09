'use client';

import type {
  HouseholdMemberDto,
  OwnershipDto,
  PersonDto,
  PropertyDetailResponse,
  TenancyDto,
  UnitDetailResponse,
  UnitResidentsResponse,
  VehicleDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { PersonSelect } from '@/components/person-select';
import {
  Alert,
  Button,
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
  enumLabel,
  errorMessage,
  fieldErrors,
  HOUSEHOLD_RELATIONSHIPS,
  roleLabel,
  ruleMessage,
  todayIso,
} from '@/lib/messages';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';

/**
 * One unit. Staff (property.resident.read at the property) manage owners, tenancies, household
 * and vehicles; residents of the unit see who lives there. The API enforces every rule.
 */
export default function UnitPage() {
  const { organisationId, propertyId, unitId } = useParams<{
    organisationId: string;
    propertyId: string;
    unitId: string;
  }>();
  const propertyBase = `/organisations/${organisationId}/properties/${propertyId}`;
  const base = `${propertyBase}/units/${unitId}`;
  const unit = useApiQuery<UnitDetailResponse>(base);
  // Residents cannot read the property itself (404): they simply get the resident view.
  const property = useApiQuery<PropertyDetailResponse>(propertyBase);

  useEffect(() => {
    if (unit.status === 'success') document.title = `Unit ${unit.data.unitNumber} · VEYRA Console`;
  }, [unit]);

  if (unit.status === 'loading' || property.status === 'loading')
    return <LoadingState label="Loading unit" />;
  if (unit.status === 'error') {
    if (unit.error instanceof ApiRequestError && unit.error.status === 404) {
      return (
        <EmptyState title="Unit not found">
          It does not exist, or you do not have access to it.
        </EmptyState>
      );
    }
    return <ErrorState error={unit.error} onRetry={unit.reload} />;
  }

  const u = unit.data;
  const staff = property.status === 'success' ? property.data.permissions : [];
  const canRead = staff.includes('property.resident.read');
  const canManage = staff.includes('property.resident.manage') && u.status === 'ACTIVE';

  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        {property.status === 'success' ? (
          <Link href={propertyBase}>{property.data.name}</Link>
        ) : (
          <Link href={`/organisations/${organisationId}`}>{u.propertyName}</Link>
        )}
      </nav>
      <div className="page__header">
        <h1>Unit {u.unitNumber}</h1>
        <StatusBadge status={u.status} />
      </div>
      <Card title="About this unit">
        <dl className="details">
          <div>
            <dt>Property</dt>
            <dd>{u.propertyName}</dd>
          </div>
          <div>
            <dt>Building and floor</dt>
            <dd>{[u.buildingName, u.floorName].filter(Boolean).join(' · ') || '—'}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>{enumLabel(u.unitType)}</dd>
          </div>
          <div>
            <dt>Area</dt>
            <dd>{u.areaSqm ? `${u.areaSqm} m²` : '—'}</dd>
          </div>
          {u.myRoles.length > 0 ? (
            <div>
              <dt>You are</dt>
              <dd>{u.myRoles.map(roleLabel).join(', ')}</dd>
            </div>
          ) : null}
        </dl>
      </Card>

      {canRead ? (
        <StaffResidency
          propertyBase={propertyBase}
          base={base}
          unitId={unitId}
          canManage={canManage}
        />
      ) : u.permissions.includes('unit.residents.read') ? (
        <WhoLivesHere base={base} />
      ) : null}
    </>
  );
}

/** Resident view: current owners, tenants and household, names only. */
function WhoLivesHere({ base }: { base: string }) {
  const residents = useApiQuery<UnitResidentsResponse>(`${base}/residents`);
  if (residents.status === 'loading') return <LoadingState label="Loading residents" />;
  if (residents.status === 'error')
    return <ErrorState error={residents.error} onRetry={residents.reload} />;
  const r = residents.data;
  const rows = [
    ...r.owners.map((o) => ({
      key: `o-${o.personId}`,
      name: o.fullName,
      role: `Owner (${o.shareNumerator}/${o.shareDenominator})`,
    })),
    ...r.tenants.map((t) => ({
      key: `t-${t.personId}`,
      name: t.fullName,
      role: t.isPrimary ? 'Tenant (primary)' : 'Tenant',
    })),
    ...r.household.map((h) => ({
      key: `h-${h.personId}`,
      name: h.fullName,
      role: enumLabel(h.relationship),
    })),
  ];
  return (
    <Card title="Who lives here">
      {rows.length === 0 ? <p className="muted">No current residents are recorded.</p> : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Current residents">
          {rows.map((row) => (
            <li key={row.key} className="list__item">
              <p className="list__primary">{row.name}</p>
              <p className="list__meta">{row.role}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function StaffResidency({
  propertyBase,
  base,
  unitId,
  canManage,
}: {
  propertyBase: string;
  base: string;
  unitId: string;
  canManage: boolean;
}) {
  const people = useApiQuery<{ data: PersonDto[] }>(`${propertyBase}/persons?limit=200`);
  const list = people.status === 'success' ? people.data.data : [];
  return (
    <>
      <Owners base={base} propertyBase={propertyBase} people={list} canManage={canManage} />
      <Tenancies base={base} propertyBase={propertyBase} people={list} canManage={canManage} />
      <Household base={base} propertyBase={propertyBase} people={list} canManage={canManage} />
      <Vehicles propertyBase={propertyBase} unitId={unitId} canManage={canManage} />
    </>
  );
}

const personLink = (propertyBase: string, personId: string, name: string) => (
  <Link href={`${propertyBase}/persons/${personId}`}>{name}</Link>
);
const period = (from: string, to: string | null) => `${from} – ${to ?? 'present'}`;

function Owners({
  base,
  propertyBase,
  people,
  canManage,
}: {
  base: string;
  propertyBase: string;
  people: PersonDto[];
  canManage: boolean;
}) {
  const ownerships = useApiQuery<{ data: OwnershipDto[] }>(`${base}/ownerships`);
  const action = useAction();
  const [rows, setRows] = useState(1);

  async function onSet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const owners = Array.from({ length: rows }, (_, i) => ({
      personId: String(form.get(`owner-${i}`) ?? ''),
      shareNumerator: Number(form.get(`num-${i}`)),
      shareDenominator: Number(form.get(`den-${i}`)),
    }));
    const ok = await action.run(() =>
      api.post(`${base}/owners`, {
        effectiveFrom: String(form.get('effectiveFrom') ?? ''),
        owners,
      }),
    );
    if (ok) {
      formElement.reset();
      setRows(1);
      ownerships.reload();
    }
  }

  const history = ownerships.status === 'success' ? ownerships.data.data : [];
  return (
    <Card title="Owners">
      {ownerships.status === 'loading' ? <LoadingState label="Loading owners" /> : null}
      {ownerships.status === 'error' ? (
        <ErrorState error={ownerships.error} onRetry={ownerships.reload} />
      ) : null}
      {ownerships.status === 'success' && history.length === 0 ? (
        <p className="muted">No ownership recorded yet.</p>
      ) : null}
      {history.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Ownership history</caption>
            <thead>
              <tr>
                <th scope="col">Owner</th>
                <th scope="col">Share</th>
                <th scope="col">Period</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((o) => (
                <tr key={o.id}>
                  <td>{personLink(propertyBase, o.personId, o.fullName)}</td>
                  <td>
                    {o.shareNumerator}/{o.shareDenominator}
                  </td>
                  <td>{period(o.effectiveFrom, o.effectiveTo)}</td>
                  <td>
                    {o.voidedAt ? `Voided: ${o.voidReason}` : o.effectiveTo ? 'Ended' : 'Current'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {canManage ? (
        <form className="form" onSubmit={onSet} noValidate aria-label="Set owners">
          <h3 className="section-title">Set owners from a date</h3>
          <p className="muted">
            Current owners end the day before. Shares must add up to exactly one, for example 1/2
            and 1/2.
          </p>
          {action.error ? <Alert>{ruleMessage(action.error, 'owners')}</Alert> : null}
          <TextField
            label="From"
            name="effectiveFrom"
            type="date"
            required
            defaultValue={todayIso()}
            error={fieldErrors(action.error).effectiveFrom}
          />
          {Array.from({ length: rows }, (_, i) => (
            <div className="form__row" key={`owner-row-${i.toString()}`}>
              <PersonSelect label={`Owner ${i + 1}`} name={`owner-${i}`} people={people} />
              <TextField
                label={`Share of owner ${i + 1}: numerator`}
                name={`num-${i}`}
                type="number"
                min={1}
                required
                defaultValue="1"
              />
              <TextField
                label={`Share of owner ${i + 1}: denominator`}
                name={`den-${i}`}
                type="number"
                min={1}
                required
                defaultValue={String(rows)}
              />
            </div>
          ))}
          <div className="form__actions">
            {rows < 5 ? (
              <Button variant="secondary" onClick={() => setRows(rows + 1)}>
                Add co-owner
              </Button>
            ) : null}
            <Button type="submit" busy={action.busy}>
              Save owners
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

function Tenancies({
  base,
  propertyBase,
  people,
  canManage,
}: {
  base: string;
  propertyBase: string;
  people: PersonDto[];
  canManage: boolean;
}) {
  const tenancies = useApiQuery<{ data: TenancyDto[] }>(`${base}/tenancies`);
  const create = useAction();
  const end = useAction();

  async function onMoveIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const primary = String(form.get('primary') ?? '');
    const second = String(form.get('second') ?? '');
    const endDate = String(form.get('endDate') ?? '');
    const ok = await create.run(() =>
      api.post(`${base}/tenancies`, {
        startDate: String(form.get('startDate') ?? ''),
        ...(endDate ? { endDate } : {}),
        occupants: [
          { personId: primary, isPrimary: true },
          ...(second && second !== primary ? [{ personId: second }] : []),
        ],
      }),
    );
    if (ok) {
      formElement.reset();
      tenancies.reload();
    }
  }

  async function onMoveOut(event: FormEvent<HTMLFormElement>, tenancyId: string) {
    event.preventDefault();
    const endDate = String(new FormData(event.currentTarget).get('endDate') ?? '');
    const ok = await end.run(() => api.post(`${base}/tenancies/${tenancyId}/end`, { endDate }));
    if (ok) tenancies.reload();
  }

  const rows = tenancies.status === 'success' ? tenancies.data.data : [];
  const open = rows.find((t) => t.voidedAt === null && t.endDate === null);
  return (
    <Card title="Tenancies">
      {tenancies.status === 'loading' ? <LoadingState label="Loading tenancies" /> : null}
      {tenancies.status === 'error' ? (
        <ErrorState error={tenancies.error} onRetry={tenancies.reload} />
      ) : null}
      {tenancies.status === 'success' && rows.length === 0 ? (
        <p className="muted">No tenancies recorded.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Tenancies">
          {rows.map((t) => (
            <li key={t.id} className="list__item">
              <div>
                <p className="list__primary">
                  {t.occupants.map((o, i) => (
                    <span key={o.personId}>
                      {i > 0 ? ', ' : ''}
                      {personLink(propertyBase, o.personId, o.fullName)}
                      {o.isPrimary ? ' (primary)' : ''}
                    </span>
                  ))}
                </p>
                <p className="list__meta">
                  {period(t.startDate, t.endDate)}
                  {t.voidedAt ? ` · voided: ${t.voidReason}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {canManage && open ? (
        <form
          className="form form--inline"
          onSubmit={(event) => void onMoveOut(event, open.id)}
          noValidate
          aria-label="Move out"
        >
          {end.error ? <Alert>{errorMessage(end.error)}</Alert> : null}
          <TextField
            label="Last day of the tenancy"
            name="endDate"
            type="date"
            required
            defaultValue={todayIso()}
          />
          <Button type="submit" busy={end.busy}>
            Move out
          </Button>
        </form>
      ) : null}
      {canManage ? (
        <form className="form form--inline" onSubmit={onMoveIn} noValidate aria-label="Move in">
          {create.error ? <Alert>{ruleMessage(create.error, 'occupants')}</Alert> : null}
          <TextField
            label="Move-in date"
            name="startDate"
            type="date"
            required
            defaultValue={todayIso()}
          />
          <TextField label="End date (optional)" name="endDate" type="date" />
          <PersonSelect label="Primary tenant" name="primary" people={people} />
          <PersonSelect
            label="Second tenant (optional)"
            name="second"
            people={people}
            required={false}
            emptyLabel="None"
          />
          <Button type="submit" busy={create.busy}>
            Move in
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

function Household({
  base,
  propertyBase,
  people,
  canManage,
}: {
  base: string;
  propertyBase: string;
  people: PersonDto[];
  canManage: boolean;
}) {
  const household = useApiQuery<{ data: HouseholdMemberDto[] }>(`${base}/household`);
  const add = useAction();
  const end = useAction();

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const ok = await add.run(() =>
      api.post(`${base}/household`, {
        personId: String(form.get('personId') ?? ''),
        relationship: String(form.get('relationship') ?? ''),
        validFrom: String(form.get('validFrom') ?? ''),
      }),
    );
    if (ok) {
      formElement.reset();
      household.reload();
    }
  }

  async function onEnd(event: FormEvent<HTMLFormElement>, memberId: string) {
    event.preventDefault();
    const endDate = String(new FormData(event.currentTarget).get('endDate') ?? '');
    const ok = await end.run(() => api.post(`${base}/household/${memberId}/end`, { endDate }));
    if (ok) household.reload();
  }

  const rows =
    household.status === 'success' ? household.data.data.filter((h) => h.voidedAt === null) : [];
  return (
    <Card title="Household">
      {end.error ? <Alert>{errorMessage(end.error)}</Alert> : null}
      {household.status === 'loading' ? <LoadingState label="Loading household" /> : null}
      {household.status === 'error' ? (
        <ErrorState error={household.error} onRetry={household.reload} />
      ) : null}
      {household.status === 'success' && rows.length === 0 ? (
        <p className="muted">No household members recorded.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Household members">
          {rows.map((h) => (
            <li key={h.id} className="list__item">
              <div>
                <p className="list__primary">{personLink(propertyBase, h.personId, h.fullName)}</p>
                <p className="list__meta">
                  {enumLabel(h.relationship)} · {period(h.validFrom, h.validTo)}
                </p>
              </div>
              {canManage && h.validTo === null ? (
                <form
                  className="form form--inline"
                  onSubmit={(event) => void onEnd(event, h.id)}
                  noValidate
                  aria-label={`End ${h.fullName} in the household`}
                >
                  <TextField
                    label={`Last day for ${h.fullName}`}
                    name="endDate"
                    type="date"
                    required
                    defaultValue={todayIso()}
                  />
                  <Button type="submit" variant="secondary" busy={end.busy}>
                    End
                  </Button>
                </form>
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
          aria-label="Add household member"
        >
          {add.error ? <Alert>{errorMessage(add.error)}</Alert> : null}
          <PersonSelect label="Household member" name="personId" people={people} />
          <SelectField label="Relationship" name="relationship" defaultValue="CHILD">
            {HOUSEHOLD_RELATIONSHIPS.map((r) => (
              <option key={r} value={r}>
                {enumLabel(r)}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Living here from"
            name="validFrom"
            type="date"
            required
            defaultValue={todayIso()}
          />
          <Button type="submit" busy={add.busy}>
            Add to household
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

function Vehicles({
  propertyBase,
  unitId,
  canManage,
}: {
  propertyBase: string;
  unitId: string;
  canManage: boolean;
}) {
  const vehicles = useApiQuery<{ data: VehicleDto[] }>(`${propertyBase}/vehicles`);
  const add = useAction();
  const archive = useAction();

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const text = (name: string) => String(form.get(name) ?? '').trim() || undefined;
    const ok = await add.run(() =>
      api.post(`${propertyBase}/vehicles`, {
        plate: text('plate'),
        make: text('make'),
        model: text('model'),
        unitId,
      }),
    );
    if (ok) {
      formElement.reset();
      vehicles.reload();
    }
  }

  const rows =
    vehicles.status === 'success' ? vehicles.data.data.filter((v) => v.unitId === unitId) : [];
  return (
    <Card title="Vehicles">
      {archive.error ? <Alert>{errorMessage(archive.error)}</Alert> : null}
      {vehicles.status === 'loading' ? <LoadingState label="Loading vehicles" /> : null}
      {vehicles.status === 'error' ? (
        <ErrorState error={vehicles.error} onRetry={vehicles.reload} />
      ) : null}
      {vehicles.status === 'success' && rows.length === 0 ? (
        <p className="muted">No vehicles registered for this unit.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Vehicles">
          {rows.map((v) => (
            <li key={v.id} className="list__item">
              <div>
                <p className="list__primary">{v.plate}</p>
                <p className="list__meta">
                  {[v.make, v.model, v.colour].filter(Boolean).join(' ') || '—'}
                </p>
              </div>
              {canManage ? (
                <Button
                  variant="danger"
                  busy={archive.busy}
                  aria-label={`Remove vehicle ${v.plate}`}
                  onClick={() =>
                    void archive
                      .run(() => api.post(`${propertyBase}/vehicles/${v.id}/archive`))
                      .then((ok) => ok && vehicles.reload())
                  }
                >
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canManage ? (
        <form className="form form--inline" onSubmit={onAdd} noValidate aria-label="Add vehicle">
          {add.error ? <Alert>{errorMessage(add.error)}</Alert> : null}
          <TextField
            label="Plate"
            name="plate"
            required
            maxLength={20}
            error={fieldErrors(add.error).plate}
          />
          <TextField label="Make (optional)" name="make" maxLength={60} />
          <TextField label="Model (optional)" name="model" maxLength={60} />
          <Button type="submit" busy={add.busy}>
            Add vehicle
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
