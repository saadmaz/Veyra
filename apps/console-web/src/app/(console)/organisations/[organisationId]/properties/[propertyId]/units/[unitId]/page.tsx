'use client';

import type {
  PersonDto,
  PropertyDetailResponse,
  PropertyResidentDto,
  UnitDetailResponse,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NewPersonForm, type PersonOption } from '@/components/residents';
import { Alert, Card, EmptyState, ErrorState, LoadingState, StatusBadge } from '@/components/ui';
import {
  HouseholdCard,
  OwnersCard,
  TenanciesCard,
  UnitVehiclesCard,
} from '@/components/unit-records';
import { ApiRequestError } from '@/lib/api-client';
import { enumLabel } from '@/lib/messages';
import { todayIn } from '@/lib/residents';
import { useApiQuery } from '@/lib/use-api';

/** One unit: its details, and for staff with resident access its owners, tenants and household. */
export default function UnitPage() {
  const { organisationId, propertyId, unitId } = useParams<{
    organisationId: string;
    propertyId: string;
    unitId: string;
  }>();
  const propertyBase = `/organisations/${organisationId}/properties/${propertyId}`;
  const property = useApiQuery<PropertyDetailResponse>(propertyBase);
  const unit = useApiQuery<UnitDetailResponse>(`${propertyBase}/units/${unitId}`);

  useEffect(() => {
    if (unit.status === 'success') document.title = `Unit ${unit.data.unitNumber} · VEYRA Console`;
  }, [unit]);

  if (unit.status === 'loading' || property.status === 'loading') {
    return <LoadingState label="Loading unit" />;
  }
  for (const query of [property, unit]) {
    if (query.status === 'error') {
      if (query.error instanceof ApiRequestError && query.error.status === 404) {
        return (
          <EmptyState title="Unit not found">
            It does not exist, or you do not have access to it.
          </EmptyState>
        );
      }
      return <ErrorState error={query.error} onRetry={query.reload} />;
    }
  }
  if (unit.status !== 'success' || property.status !== 'success') return null;

  const u = unit.data;
  const p = property.data;
  // The API enforces every permission; these only decide what to show.
  const canRead = p.permissions.includes('property.resident.read');
  const canManage = p.permissions.includes('property.resident.manage') && u.status === 'ACTIVE';

  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href={propertyBase}>{p.name}</Link>
      </nav>
      <div className="page__header">
        <h1>Unit {u.unitNumber}</h1>
        <StatusBadge status={u.status} />
      </div>
      {u.status === 'ARCHIVED' ? (
        <Alert tone="info">
          This unit is archived. Its records stay visible, but nothing can be changed.
        </Alert>
      ) : null}

      <Card title="Unit details">
        <dl className="details">
          <div>
            <dt>Type</dt>
            <dd>{enumLabel(u.unitType)}</dd>
          </div>
          <div>
            <dt>Building</dt>
            <dd>{u.buildingName ?? 'None (stand-alone unit)'}</dd>
          </div>
          <div>
            <dt>Floor</dt>
            <dd>{u.floorName ?? '—'}</dd>
          </div>
          <div>
            <dt>Area</dt>
            <dd>{u.areaSqm ? `${u.areaSqm} m²` : '—'}</dd>
          </div>
        </dl>
      </Card>

      {canRead ? (
        <UnitResidents
          propertyBase={propertyBase}
          unitId={unitId}
          today={todayIn(p.timeZone)}
          canManage={canManage}
        />
      ) : (
        <Card title="Residents">
          <p className="muted">
            Resident details are not available to your role. Organisation admins and the property's
            managers can see them.
          </p>
        </Card>
      )}
    </>
  );
}

function UnitResidents({
  propertyBase,
  unitId,
  today,
  canManage,
}: {
  propertyBase: string;
  unitId: string;
  today: string;
  canManage: boolean;
}) {
  // People the forms can choose: the property's current residents, plus anyone added here.
  const residents = useApiQuery<{ data: PropertyResidentDto[] }>(`${propertyBase}/residents`);
  const [added, setAdded] = useState<PersonDto[]>([]);
  const people = useMemo<PersonOption[]>(() => {
    const byId = new Map<string, PersonOption>();
    if (residents.status === 'success') {
      for (const r of residents.data.data)
        if (r.person.status === 'ACTIVE') byId.set(r.person.id, r.person);
    }
    for (const p of added) byId.set(p.id, p);
    return [...byId.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [residents, added]);
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const reloadResidents = residents.reload;
  const onChanged = useCallback(() => reloadResidents(), [reloadResidents]);

  const shared = { propertyBase, unitId, today, canManage, people, onChanged };
  return (
    <>
      {canManage ? (
        <Card title="Add a person">
          <p className="muted">
            Owners, tenants and household members are chosen from this property's current residents.
            Add anyone new here first, then choose them below.
          </p>
          {residents.status === 'error' ? (
            <ErrorState error={residents.error} onRetry={residents.reload} />
          ) : null}
          {lastAdded ? (
            <Alert tone="success">{lastAdded} was added and can now be chosen below.</Alert>
          ) : null}
          <NewPersonForm
            base={propertyBase}
            onCreated={(person) => {
              setAdded((list) => [...list, person]);
              setLastAdded(person.fullName);
            }}
          />
        </Card>
      ) : null}
      <OwnersCard {...shared} />
      <TenanciesCard {...shared} />
      <HouseholdCard {...shared} />
      <UnitVehiclesCard propertyBase={propertyBase} unitId={unitId} canManage={canManage} />
    </>
  );
}
