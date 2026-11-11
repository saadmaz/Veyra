'use client';

import type {
  HouseholdMemberDto,
  OwnershipDto,
  TenancyDto,
  VehicleDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import {
  EndPeriodForm,
  PeriodBadge,
  type PersonOption,
  PersonSelect,
  promptVoidReason,
} from '@/components/residents';
import {
  Alert,
  Button,
  Card,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api-client';
import { enumLabel, errorMessage, fieldErrors, HOUSEHOLD_RELATIONSHIPS } from '@/lib/messages';
import {
  formatDate,
  formatPeriod,
  formatShare,
  groupOwnerships,
  parseShare,
  periodStatus,
  type Share,
  sharesSumToOne,
} from '@/lib/residents';
import { confirmArchive, useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';

/*
 * Resident records of one unit, for staff. Every rule is enforced by the API (permissions,
 * exact shares, non-overlapping periods, archived units); the checks here only give faster
 * feedback. Records are never edited in place: periods are ended, and mistakes are voided.
 */

export interface UnitRecordsProps {
  /** …/organisations/:id/properties/:id (same path in the console and the API). */
  propertyBase: string;
  unitId: string;
  /** Today in the property's time zone (YYYY-MM-DD). */
  today: string;
  canManage: boolean;
  people: PersonOption[];
  /** Called after any change, so lists that depend on residents refresh. */
  onChanged: () => void;
}

const MAX_ROWS = 10;

function PersonLink({ base, id, name }: { base: string; id: string; name: string }) {
  return (
    <Link href={`${base}/residents/${id}`} className="list__link">
      {name}
    </Link>
  );
}

/** Adds and removes rows of a multi-person form (owners, tenants). */
function RowControls({
  rows,
  setRows,
  addLabel,
  removeLabel,
}: {
  rows: number;
  setRows: (rows: number) => void;
  addLabel: string;
  removeLabel: string;
}) {
  return (
    <div className="form__actions">
      {rows < MAX_ROWS ? (
        <Button variant="secondary" onClick={() => setRows(rows + 1)}>
          {addLabel}
        </Button>
      ) : null}
      {rows > 1 ? (
        <Button variant="secondary" onClick={() => setRows(rows - 1)}>
          {removeLabel}
        </Button>
      ) : null}
    </div>
  );
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function duplicates(ids: string[]): boolean {
  return new Set(ids).size !== ids.length;
}

// ------------------------------------------------------------------------------ owners

export function OwnersCard(props: UnitRecordsProps) {
  const { propertyBase, unitId, today, canManage, people, onChanged } = props;
  const unitPath = `${propertyBase}/units/${unitId}`;
  const ownerships = useApiQuery<{ data: OwnershipDto[] }>(`${unitPath}/ownerships`);
  const save = useAction();
  const voiding = useAction();
  const [rows, setRows] = useState(1);
  const [problem, setProblem] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const owners: (Share & { personId: string })[] = [];
    for (const i of range(rows)) {
      const personId = String(form.get(`owner-${i}`) ?? '');
      const share = parseShare(String(form.get(`share-${i}`) ?? ''));
      if (!personId) return setProblem('Choose a person for every owner.');
      if (!share)
        return setProblem('Enter each share as 1 for the whole unit, or a fraction such as 1/2.');
      owners.push({ personId, ...share });
    }
    if (duplicates(owners.map((o) => o.personId)))
      return setProblem('Each person can be listed once.');
    if (!sharesSumToOne(owners))
      return setProblem('Shares must add up to exactly one (for example 1/2 + 1/2, or 1/3 + 2/3).');
    setProblem(null);
    const ok = await save.run(() =>
      api.post(`${unitPath}/owners`, {
        effectiveFrom: String(form.get('effectiveFrom') ?? ''),
        owners,
      }),
    );
    if (ok) {
      formElement.reset();
      setRows(1);
      ownerships.reload();
      onChanged();
    }
  }

  const fields = fieldErrors(save.error);
  const groups = ownerships.status === 'success' ? groupOwnerships(ownerships.data.data) : [];
  return (
    <Card title="Owners">
      {voiding.error ? <Alert>{errorMessage(voiding.error)}</Alert> : null}
      {ownerships.status === 'loading' ? <LoadingState label="Loading owners" /> : null}
      {ownerships.status === 'error' ? (
        <ErrorState error={ownerships.error} onRetry={ownerships.reload} />
      ) : null}
      {ownerships.status === 'success' && groups.length === 0 ? (
        <p className="muted">No owners recorded yet.</p>
      ) : null}
      {groups.length > 0 ? (
        <ul className="list" aria-label="Ownership history">
          {groups.map((g) => {
            const status = periodStatus(g.effectiveFrom, g.effectiveTo, g.voidedAt, today);
            return (
              <li key={g.key} className="list__item">
                <div>
                  <p className="list__primary">
                    {g.owners.map((o, i) => (
                      <span key={o.id}>
                        {i > 0 ? ', ' : null}
                        <PersonLink base={propertyBase} id={o.personId} name={o.fullName} />{' '}
                        <span className="muted">({formatShare(o)})</span>
                      </span>
                    ))}
                  </p>
                  <p className="list__meta">
                    {formatPeriod(g.effectiveFrom, g.effectiveTo)}
                    {g.voidReason ? ` · Voided: ${g.voidReason}` : null}
                  </p>
                </div>
                <div className="form__actions">
                  <PeriodBadge status={status} />
                  {canManage && status !== 'VOIDED' ? (
                    <Button
                      variant="danger"
                      busy={voiding.busy}
                      aria-label={`Void owners from ${formatDate(g.effectiveFrom)}`}
                      onClick={() => {
                        const reason = promptVoidReason('this ownership record');
                        if (!reason) return;
                        void voiding
                          .run(() =>
                            api.post(`${unitPath}/ownerships/void`, {
                              ownershipIds: g.owners.map((o) => o.id),
                              reason,
                            }),
                          )
                          .then((ok) => {
                            if (!ok) return;
                            ownerships.reload();
                            onChanged();
                          });
                      }}
                    >
                      Void
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {canManage ? (
        <form
          className="form form--inline"
          onSubmit={onSubmit}
          noValidate
          aria-label="Record owners"
        >
          {problem ? <Alert>{problem}</Alert> : null}
          {save.error ? <Alert>{errorMessage(save.error)}</Alert> : null}
          <p className="muted form__full">
            Records the first owners or a transfer. Current owners end the day before this date.
          </p>
          <TextField
            label="Owners from"
            name="effectiveFrom"
            type="date"
            required
            defaultValue={today}
            error={fields.effectiveFrom}
          />
          <fieldset className="fieldset form__full">
            <legend>New owners</legend>
            {range(rows).map((i) => (
              <div key={i} className="form__row">
                <PersonSelect
                  label={rows === 1 ? 'Owner' : `Owner ${i + 1}`}
                  name={`owner-${i}`}
                  people={people}
                />
                <TextField
                  label={rows === 1 ? 'Share' : `Share of owner ${i + 1}`}
                  name={`share-${i}`}
                  required
                  maxLength={15}
                  defaultValue={rows === 1 ? '1' : ''}
                  hint="1 for the whole unit, or a fraction such as 1/2"
                />
              </div>
            ))}
            {fields.owners ? <p className="field__error">{fields.owners}</p> : null}
            <RowControls
              rows={rows}
              setRows={setRows}
              addLabel="Add another owner"
              removeLabel="Remove last owner"
            />
          </fieldset>
          <Button type="submit" busy={save.busy}>
            Record owners
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------------------ tenancies

export function TenanciesCard(props: UnitRecordsProps) {
  const { propertyBase, unitId, today, canManage, people, onChanged } = props;
  const unitPath = `${propertyBase}/units/${unitId}`;
  const tenancies = useApiQuery<{ data: TenancyDto[] }>(`${unitPath}/tenancies`);
  const create = useAction();
  const change = useAction();
  const [rows, setRows] = useState(1);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = (ok: boolean) => {
    if (!ok) return;
    tenancies.reload();
    onChanged();
  };

  async function onMoveIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const ids = range(rows).map((i) => String(form.get(`tenant-${i}`) ?? ''));
    if (ids.some((id) => !id)) return setProblem('Choose a person for every tenant.');
    if (duplicates(ids)) return setProblem('Each person can be listed once.');
    setProblem(null);
    const endDate = String(form.get('endDate') ?? '');
    const ok = await create.run(() =>
      api.post(`${unitPath}/tenancies`, {
        startDate: String(form.get('startDate') ?? ''),
        ...(endDate ? { endDate } : {}),
        occupants: ids.map((personId, i) => ({ personId, isPrimary: i === 0 })),
      }),
    );
    if (ok) {
      formElement.reset();
      setRows(1);
    }
    refresh(ok);
  }

  const fields = fieldErrors(create.error);
  const sorted =
    tenancies.status === 'success'
      ? [...tenancies.data.data].sort((a, b) => (a.startDate < b.startDate ? 1 : -1))
      : [];
  return (
    <Card title="Tenancies">
      {change.error ? <Alert>{errorMessage(change.error)}</Alert> : null}
      {tenancies.status === 'loading' ? <LoadingState label="Loading tenancies" /> : null}
      {tenancies.status === 'error' ? (
        <ErrorState error={tenancies.error} onRetry={tenancies.reload} />
      ) : null}
      {tenancies.status === 'success' && sorted.length === 0 ? (
        <p className="muted">No tenancies recorded. The unit is not rented out.</p>
      ) : null}
      {sorted.length > 0 ? (
        <ul className="list" aria-label="Tenancy history">
          {sorted.map((t) => {
            const status = periodStatus(t.startDate, t.endDate, t.voidedAt, today);
            const primary = t.occupants.find((o) => o.isPrimary);
            return (
              <li key={t.id} className="list__item">
                <div>
                  <p className="list__primary">
                    {t.occupants.map((o, i) => (
                      <span key={o.personId}>
                        {i > 0 ? ', ' : null}
                        <PersonLink base={propertyBase} id={o.personId} name={o.fullName} />
                        {o.isPrimary ? <span className="muted"> (primary)</span> : null}
                      </span>
                    ))}
                  </p>
                  <p className="list__meta">
                    {formatPeriod(t.startDate, t.endDate)}
                    {t.voidReason ? ` · Voided: ${t.voidReason}` : null}
                  </p>
                </div>
                <div className="form__actions">
                  <PeriodBadge status={status} />
                  {canManage && status !== 'VOIDED' ? (
                    <Button
                      variant="danger"
                      busy={change.busy}
                      aria-label={`Void tenancy of ${primary?.fullName ?? 'this unit'}`}
                      onClick={() => {
                        const reason = promptVoidReason('this tenancy');
                        if (!reason) return;
                        void change
                          .run(() => api.post(`${unitPath}/tenancies/${t.id}/void`, { reason }))
                          .then(refresh);
                      }}
                    >
                      Void
                    </Button>
                  ) : null}
                </div>
                {canManage && (status === 'CURRENT' || status === 'UPCOMING') ? (
                  <EndPeriodForm
                    label="Last day of the tenancy"
                    submitLabel={`Record move-out of ${primary?.fullName ?? 'tenants'}`}
                    min={t.startDate}
                    defaultValue={t.endDate ?? today}
                    busy={change.busy}
                    onSubmit={(endDate) =>
                      void change
                        .run(() => api.post(`${unitPath}/tenancies/${t.id}/end`, { endDate }))
                        .then(refresh)
                    }
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {canManage ? (
        <form
          className="form form--inline"
          onSubmit={onMoveIn}
          noValidate
          aria-label="Record move-in"
        >
          {problem ? <Alert>{problem}</Alert> : null}
          {create.error ? <Alert>{errorMessage(create.error)}</Alert> : null}
          <TextField
            label="Move-in date"
            name="startDate"
            type="date"
            required
            defaultValue={today}
            error={fields.startDate}
          />
          <TextField
            label="Last day (optional)"
            name="endDate"
            type="date"
            hint="Leave empty for an open-ended tenancy"
            error={fields.endDate}
          />
          <fieldset className="fieldset form__full">
            <legend>Tenants</legend>
            {range(rows).map((i) => (
              <PersonSelect
                key={i}
                label={i === 0 ? 'Primary tenant' : `Tenant ${i + 1}`}
                name={`tenant-${i}`}
                people={people}
              />
            ))}
            {fields.occupants ? <p className="field__error">{fields.occupants}</p> : null}
            <RowControls
              rows={rows}
              setRows={setRows}
              addLabel="Add another tenant"
              removeLabel="Remove last tenant"
            />
          </fieldset>
          <Button type="submit" busy={create.busy}>
            Record move-in
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------------------ household

export function HouseholdCard(props: UnitRecordsProps) {
  const { propertyBase, unitId, today, canManage, people, onChanged } = props;
  const unitPath = `${propertyBase}/units/${unitId}`;
  const household = useApiQuery<{ data: HouseholdMemberDto[] }>(`${unitPath}/household`);
  const add = useAction();
  const change = useAction();

  const refresh = (ok: boolean) => {
    if (!ok) return;
    household.reload();
    onChanged();
  };

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const validTo = String(form.get('validTo') ?? '');
    const ok = await add.run(() =>
      api.post(`${unitPath}/household`, {
        personId: String(form.get('personId') ?? ''),
        relationship: String(form.get('relationship') ?? ''),
        validFrom: String(form.get('validFrom') ?? ''),
        ...(validTo ? { validTo } : {}),
      }),
    );
    if (ok) formElement.reset();
    refresh(ok);
  }

  const fields = fieldErrors(add.error);
  const sorted =
    household.status === 'success'
      ? [...household.data.data].sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))
      : [];
  return (
    <Card title="Household members">
      {change.error ? <Alert>{errorMessage(change.error)}</Alert> : null}
      {household.status === 'loading' ? <LoadingState label="Loading household" /> : null}
      {household.status === 'error' ? (
        <ErrorState error={household.error} onRetry={household.reload} />
      ) : null}
      {household.status === 'success' && sorted.length === 0 ? (
        <p className="muted">No household members recorded.</p>
      ) : null}
      {sorted.length > 0 ? (
        <ul className="list" aria-label="Household members">
          {sorted.map((h) => {
            const status = periodStatus(h.validFrom, h.validTo, h.voidedAt, today);
            return (
              <li key={h.id} className="list__item">
                <div>
                  <p className="list__primary">
                    <PersonLink base={propertyBase} id={h.personId} name={h.fullName} />
                  </p>
                  <p className="list__meta">
                    {enumLabel(h.relationship)} · {formatPeriod(h.validFrom, h.validTo)}
                  </p>
                </div>
                <div className="form__actions">
                  <PeriodBadge status={status} />
                  {canManage && status !== 'VOIDED' ? (
                    <Button
                      variant="danger"
                      busy={change.busy}
                      aria-label={`Void household record of ${h.fullName}`}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Void the household record of ${h.fullName}? Use this only for a record entered by mistake.`,
                          )
                        )
                          return;
                        void change
                          .run(() => api.post(`${unitPath}/household/${h.id}/void`))
                          .then(refresh);
                      }}
                    >
                      Void
                    </Button>
                  ) : null}
                </div>
                {canManage && (status === 'CURRENT' || status === 'UPCOMING') ? (
                  <EndPeriodForm
                    label="Last day in the household"
                    submitLabel={`Record that ${h.fullName} left`}
                    min={h.validFrom}
                    defaultValue={h.validTo ?? today}
                    busy={change.busy}
                    onSubmit={(endDate) =>
                      void change
                        .run(() => api.post(`${unitPath}/household/${h.id}/end`, { endDate }))
                        .then(refresh)
                    }
                  />
                ) : null}
              </li>
            );
          })}
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
          <PersonSelect
            label="Household member"
            name="personId"
            people={people}
            error={fields.personId}
          />
          <SelectField
            label="Relationship"
            name="relationship"
            defaultValue="SPOUSE_OR_PARTNER"
            error={fields.relationship}
          >
            {HOUSEHOLD_RELATIONSHIPS.map((r) => (
              <option key={r} value={r}>
                {enumLabel(r)}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Member from"
            name="validFrom"
            type="date"
            required
            defaultValue={today}
            error={fields.validFrom}
          />
          <TextField
            label="Member until (optional)"
            name="validTo"
            type="date"
            error={fields.validTo}
          />
          <Button type="submit" busy={add.busy}>
            Add household member
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------------------ vehicles

export function UnitVehiclesCard({
  propertyBase,
  unitId,
  canManage,
}: Pick<UnitRecordsProps, 'propertyBase' | 'unitId' | 'canManage'>) {
  // The API lists the property's active vehicles; this unit's are filtered here.
  const vehicles = useApiQuery<{ data: VehicleDto[] }>(`${propertyBase}/vehicles`);
  const add = useAction();
  const archive = useAction();

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const optional = (key: string) => {
      const value = String(form.get(key) ?? '').trim();
      return value ? { [key]: value } : {};
    };
    const ok = await add.run(() =>
      api.post(`${propertyBase}/vehicles`, {
        plate: String(form.get('plate') ?? ''),
        ...optional('make'),
        ...optional('model'),
        ...optional('colour'),
        unitId,
      }),
    );
    if (ok) {
      formElement.reset();
      vehicles.reload();
    }
  }

  const fields = fieldErrors(add.error);
  const mine =
    vehicles.status === 'success' ? vehicles.data.data.filter((v) => v.unitId === unitId) : [];
  return (
    <Card title="Vehicles">
      {archive.error ? <Alert>{errorMessage(archive.error)}</Alert> : null}
      {vehicles.status === 'loading' ? <LoadingState label="Loading vehicles" /> : null}
      {vehicles.status === 'error' ? (
        <ErrorState error={vehicles.error} onRetry={vehicles.reload} />
      ) : null}
      {vehicles.status === 'success' && mine.length === 0 ? (
        <p className="muted">No vehicles registered to this unit.</p>
      ) : null}
      {mine.length > 0 ? (
        <ul className="list" aria-label="Vehicles">
          {mine.map((v) => (
            <li key={v.id} className="list__item">
              <div>
                <p className="list__primary">{v.plate}</p>
                <p className="list__meta">
                  {[v.colour, v.make, v.model].filter(Boolean).join(' ') || 'No details'}
                </p>
              </div>
              {canManage ? (
                <Button
                  variant="danger"
                  busy={archive.busy}
                  aria-label={`Archive vehicle ${v.plate}`}
                  onClick={() => {
                    if (!confirmArchive(`vehicle ${v.plate}`)) return;
                    void archive
                      .run(() => api.post(`${propertyBase}/vehicles/${v.id}/archive`))
                      .then((ok) => ok && vehicles.reload());
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
        <form className="form form--inline" onSubmit={onAdd} noValidate aria-label="Add vehicle">
          {add.error ? <Alert>{errorMessage(add.error)}</Alert> : null}
          <TextField
            label="Number plate"
            name="plate"
            required
            maxLength={20}
            autoComplete="off"
            error={fields.plate}
          />
          <TextField label="Make (optional)" name="make" maxLength={60} error={fields.make} />
          <TextField label="Model (optional)" name="model" maxLength={60} error={fields.model} />
          <TextField label="Colour (optional)" name="colour" maxLength={40} error={fields.colour} />
          <Button type="submit" busy={add.busy}>
            Add vehicle
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
