'use client';

import type {
  BuildingDto,
  FloorDto,
  Paginated,
  PropertyDetailResponse,
  UnitDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect } from 'react';
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
import { enumLabel, errorMessage, fieldErrors, UNIT_TYPES } from '@/lib/messages';
import { confirmArchive, useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';

/** One building: its floors and the units inside it. */
export default function BuildingPage() {
  const { organisationId, propertyId, buildingId } = useParams<{
    organisationId: string;
    propertyId: string;
    buildingId: string;
  }>();
  const propertyBase = `/organisations/${organisationId}/properties/${propertyId}`;
  const base = `${propertyBase}/buildings/${buildingId}`;
  const property = useApiQuery<PropertyDetailResponse>(propertyBase);
  const building = useApiQuery<BuildingDto>(base);
  // One floor list shared by both sections, so a new floor appears in the unit form at once.
  const floors = useApiQuery<Paginated<FloorDto>>(`${base}/floors?limit=200`);

  useEffect(() => {
    if (building.status === 'success') document.title = `${building.data.name} · VEYRA Console`;
  }, [building]);

  if (building.status === 'loading' || property.status === 'loading') {
    return <LoadingState label="Loading building" />;
  }
  for (const query of [property, building]) {
    if (query.status === 'error') {
      if (query.error instanceof ApiRequestError && query.error.status === 404) {
        return (
          <EmptyState title="Building not found">
            It does not exist, or you do not have access to it.
          </EmptyState>
        );
      }
      return <ErrorState error={query.error} onRetry={query.reload} />;
    }
  }
  if (building.status !== 'success' || property.status !== 'success') return null;

  const b = building.data;
  const canManage =
    property.data.permissions.includes('property.structure.manage') && b.status === 'ACTIVE';

  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href={propertyBase}>{property.data.name}</Link>
      </nav>
      <div className="page__header">
        <h1>{b.name}</h1>
        <StatusBadge status={b.status} />
      </div>
      {b.status === 'ARCHIVED' ? (
        <Alert tone="info">
          This building is archived. You can view it, but nothing can be changed.
        </Alert>
      ) : null}
      <Floors base={base} floors={floors} canManage={canManage} />
      <BuildingUnits
        propertyBase={propertyBase}
        buildingId={buildingId}
        floors={floors}
        canManage={canManage}
      />
    </>
  );
}

type FloorsQuery = ReturnType<typeof useApiQuery<Paginated<FloorDto>>>;

function Floors({
  base,
  floors,
  canManage,
}: {
  base: string;
  floors: FloorsQuery;
  canManage: boolean;
}) {
  const create = useAction();
  const archive = useAction();

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const level = Number.parseInt(String(form.get('level') ?? ''), 10);
    const ok = await create.run(() =>
      api.post(`${base}/floors`, {
        level: Number.isNaN(level) ? null : level,
        name: String(form.get('name') ?? ''),
      }),
    );
    if (ok) {
      formElement.reset();
      floors.reload();
    }
  }

  const fields = fieldErrors(create.error);
  const sorted =
    floors.status === 'success' ? [...floors.data.data].sort((a, b) => b.level - a.level) : [];
  return (
    <Card title="Floors">
      {archive.error ? <Alert>{errorMessage(archive.error)}</Alert> : null}
      {floors.status === 'loading' ? <LoadingState label="Loading floors" /> : null}
      {floors.status === 'error' ? (
        <ErrorState error={floors.error} onRetry={floors.reload} />
      ) : null}
      {floors.status === 'success' && sorted.length === 0 ? (
        <p className="muted">No floors yet.</p>
      ) : null}
      {sorted.length > 0 ? (
        <ul className="list" aria-label="Floors">
          {sorted.map((f) => (
            <li key={f.id} className="list__item">
              <div>
                <p className="list__primary">{f.name}</p>
                <p className="list__meta">Level {f.level}</p>
              </div>
              {canManage ? (
                <Button
                  variant="danger"
                  busy={archive.busy}
                  aria-label={`Archive floor ${f.name}`}
                  onClick={() => {
                    if (!confirmArchive(`floor ${f.name}`)) return;
                    void archive
                      .run(() => api.post(`${base}/floors/${f.id}/archive`))
                      .then((ok) => ok && floors.reload());
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
        <form className="form form--inline" onSubmit={onCreate} noValidate aria-label="Add floor">
          {create.error ? <Alert>{errorMessage(create.error)}</Alert> : null}
          <TextField
            label="Level"
            name="level"
            type="number"
            required
            min={-20}
            max={300}
            hint="0 is the ground floor; basements are negative"
            error={fields.level}
          />
          <TextField label="Floor name" name="name" required maxLength={60} error={fields.name} />
          <Button type="submit" busy={create.busy}>
            Add floor
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

function BuildingUnits({
  propertyBase,
  buildingId,
  floors,
  canManage,
}: {
  propertyBase: string;
  buildingId: string;
  floors: FloorsQuery;
  canManage: boolean;
}) {
  const units = useApiQuery<Paginated<UnitDto>>(
    `${propertyBase}/units?buildingId=${buildingId}&limit=200`,
  );
  const create = useAction();
  const floorName = (id: string | null) =>
    id === null
      ? '—'
      : floors.status === 'success'
        ? (floors.data.data.find((f) => f.id === id)?.name ?? '—')
        : '…';

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const floorId = String(form.get('floorId') ?? '');
    const areaSqm = String(form.get('areaSqm') ?? '').trim();
    const ok = await create.run(() =>
      api.post(`${propertyBase}/units`, {
        number: String(form.get('number') ?? ''),
        type: String(form.get('type') ?? ''),
        buildingId,
        ...(floorId ? { floorId } : {}),
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
    <Card title="Units in this building">
      {units.status === 'loading' ? <LoadingState label="Loading units" /> : null}
      {units.status === 'error' ? <ErrorState error={units.error} onRetry={units.reload} /> : null}
      {units.status === 'success' && units.data.data.length === 0 ? (
        <p className="muted">No units yet.</p>
      ) : null}
      {units.status === 'success' && units.data.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Units in this building</caption>
            <thead>
              <tr>
                <th scope="col">Unit</th>
                <th scope="col">Type</th>
                <th scope="col">Floor</th>
                <th scope="col">Area (m²)</th>
              </tr>
            </thead>
            <tbody>
              {units.data.data.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link href={`${propertyBase}/units/${u.id}`} aria-label={`Unit ${u.number}`}>
                      {u.number}
                    </Link>
                  </td>
                  <td>{enumLabel(u.type)}</td>
                  <td>{floorName(u.floorId)}</td>
                  <td>{u.areaSqm ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {canManage ? (
        <form
          className="form form--inline"
          onSubmit={onCreate}
          noValidate
          aria-label="Add unit to this building"
        >
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
          <SelectField label="Floor" name="floorId" defaultValue="" error={fields.floorId}>
            <option value="">No floor</option>
            {floors.status === 'success'
              ? floors.data.data.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} (level {f.level})
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
