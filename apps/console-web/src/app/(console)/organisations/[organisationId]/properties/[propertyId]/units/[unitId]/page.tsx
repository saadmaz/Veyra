'use client';

import type {
  PersonDto,
  PropertyDetailResponse,
  UnitDetailResponse,
  UnitResidentsResponse,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NewPersonForm } from '@/components/residents';
import {
  Alert,
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  StatusBadge,
} from '@/components/ui';
import {
  HouseholdCard,
  OwnersCard,
  TenanciesCard,
  UnitVehiclesCard,
} from '@/components/unit-records';
import { UnitVisitorsCard, WalkInRequestsCard } from '@/components/unit-visitors';
import { ApiRequestError } from '@/lib/api-client';
import { enumLabel, residentRoleLabel } from '@/lib/messages';
import { formatShare, todayIn } from '@/lib/residents';
import { useApiQuery } from '@/lib/use-api';

/**
 * One unit. Every staff role sees its details; admins and property managers manage owners,
 * tenancies, household and vehicles; owners and tenants of the unit see who lives there.
 */
export default function UnitPage() {
  const { organisationId, propertyId, unitId } = useParams<{
    organisationId: string;
    propertyId: string;
    unitId: string;
  }>();
  const propertyBase = `/organisations/${organisationId}/properties/${propertyId}`;
  const unitPath = `${propertyBase}/units/${unitId}`;
  const unit = useApiQuery<UnitDetailResponse>(unitPath);
  // Residents cannot read the property itself (404); they get the resident view instead.
  const property = useApiQuery<PropertyDetailResponse>(propertyBase);

  useEffect(() => {
    if (unit.status === 'success') document.title = `Unit ${unit.data.unitNumber} · VEYRA Console`;
  }, [unit]);

  if (unit.status === 'loading' || property.status === 'loading') {
    return <LoadingState label="Loading unit" />;
  }
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
  // A failed property request other than "no access" is a real error for staff.
  if (
    property.status === 'error' &&
    !(property.error instanceof ApiRequestError && property.error.status === 404)
  ) {
    return <ErrorState error={property.error} onRetry={property.reload} />;
  }

  const u = unit.data;
  const p = property.status === 'success' ? property.data : null;
  // The API enforces every permission; these only decide what to show.
  const staff = p?.permissions ?? [];
  const isStaff = p !== null;
  const canRead = staff.includes('property.resident.read');
  const canManage = staff.includes('property.resident.manage') && u.status === 'ACTIVE';

  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        {p ? (
          <Link href={propertyBase}>{p.name}</Link>
        ) : (
          <Link href={`/organisations/${organisationId}`}>{u.propertyName}</Link>
        )}
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
            <dt>Property</dt>
            <dd>{u.propertyName}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>{enumLabel(u.unitType)}</dd>
          </div>
          <div>
            <dt>Building and floor</dt>
            <dd>
              {[u.buildingName, u.floorName].filter(Boolean).join(' · ') ||
                'None (stand-alone unit)'}
            </dd>
          </div>
          <div>
            <dt>Area</dt>
            <dd>{u.areaSqm ? `${u.areaSqm} m²` : '—'}</dd>
          </div>
          {u.myRoles.length > 0 ? (
            <div>
              <dt>You are</dt>
              <dd>{u.myRoles.map(residentRoleLabel).join(', ')}</dd>
            </div>
          ) : null}
        </dl>
      </Card>

      {u.permissions.includes('unit.finance.read') &&
      u.myRoles.some((role) => role === 'OWNER' || role === 'TENANT') ? (
        <Card
          title="Billing"
          actions={<ButtonLink href={`${unitPath}/billing`}>Open billing</ButtonLink>}
        >
          <p className="muted">
            Your invoices, receipts and statement, and bank transfers you have told finance about.
          </p>
        </Card>
      ) : null}

      {u.permissions.includes('unit.visitor.invite') ? (
        <>
          <WalkInRequestsCard
            unitPath={unitPath}
            timeZone={u.propertyTimeZone}
            canAnswer={u.myRoles.length > 0}
          />
          <UnitVisitorsCard
            unitPath={unitPath}
            timeZone={u.propertyTimeZone}
            canInvite={u.status === 'ACTIVE'}
          />
        </>
      ) : null}

      {p && canRead ? (
        <UnitResidents
          propertyBase={propertyBase}
          unitId={unitId}
          today={todayIn(p.timeZone)}
          canManage={canManage}
        />
      ) : u.permissions.includes('unit.residents.read') ? (
        <WhoLivesHere unitPath={unitPath} />
      ) : isStaff ? (
        <Card title="Residents">
          <p className="muted">
            Resident details are not available to your role. Organisation admins and the property's
            managers can see them.
          </p>
        </Card>
      ) : null}
    </>
  );
}

/** Resident view: the unit's current owners, tenants and household, names only. */
function WhoLivesHere({ unitPath }: { unitPath: string }) {
  const residents = useApiQuery<UnitResidentsResponse>(`${unitPath}/residents`);
  if (residents.status === 'loading') return <LoadingState label="Loading residents" />;
  if (residents.status === 'error')
    return <ErrorState error={residents.error} onRetry={residents.reload} />;
  const r = residents.data;
  const rows = [
    ...r.owners.map((o) => ({
      key: `o-${o.personId}`,
      name: o.fullName,
      role: `Owner (${formatShare(o)})`,
    })),
    ...r.tenants.map((t) => ({
      key: `t-${t.personId}`,
      name: t.fullName,
      role: t.isPrimary ? 'Tenant (primary)' : 'Tenant',
    })),
    ...r.household.map((h) => ({
      key: `h-${h.personId}`,
      name: h.fullName,
      role: `Household: ${enumLabel(h.relationship).toLowerCase()}`,
    })),
  ];
  return (
    <Card title="Who lives here">
      {rows.length === 0 ? <p className="muted">No current residents are recorded.</p> : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Current residents">
          {rows.map((row) => (
            <li key={row.key} className="list__item">
              <div>
                <p className="list__primary">{row.name}</p>
                <p className="list__meta">{row.role}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
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
  // People the forms can choose: the property's residents, past and present, and profiles not
  // attached anywhere yet (the API decides which; at most 200).
  const persons = useApiQuery<{ data: PersonDto[] }>(`${propertyBase}/persons?limit=200`);
  const people = persons.status === 'success' ? persons.data.data : [];
  const [lastAdded, setLastAdded] = useState<string | null>(null);

  const shared = {
    propertyBase,
    unitId,
    today,
    canManage,
    people,
    onChanged: persons.reload,
  };
  return (
    <>
      {persons.status === 'error' ? (
        <ErrorState error={persons.error} onRetry={persons.reload} />
      ) : null}
      {canManage ? (
        <Card title="Add a person">
          <p className="muted">
            Owners, tenants and household members are chosen from this property's residents and from
            profiles not yet attached anywhere. Add anyone new here first.
          </p>
          {lastAdded ? (
            <Alert tone="success">{lastAdded} was added and can now be chosen below.</Alert>
          ) : null}
          <NewPersonForm
            base={propertyBase}
            onCreated={(person) => {
              setLastAdded(person.fullName);
              persons.reload();
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
