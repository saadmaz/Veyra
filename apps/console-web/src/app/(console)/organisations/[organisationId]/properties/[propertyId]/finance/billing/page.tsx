'use client';

import type {
  BillingRunRequest,
  BillingRunResponse,
  ChargeLiableParty,
  ChargeTypeDto,
  CreateChargeTypeRequest,
  CreateRecurringChargeRequest,
  LedgerAccountDto,
  Paginated,
  RecurringChargeDto,
  UnitDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { type FinanceContext, FinanceFrame } from '@/components/finance-frame';
import {
  Alert,
  Button,
  Card,
  CheckboxField,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api-client';
import { addDays, formatMoney, formatMonth, LIABLE_PARTY_LABELS, parseAmount } from '@/lib/finance';
import { errorMessage, fieldErrors } from '@/lib/messages';
import { todayIn } from '@/lib/residents';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';

export default function BillingPage() {
  return (
    <FinanceFrame section="billing" title="Billing setup">
      {(ctx) => <Billing ctx={ctx} />}
    </FinanceFrame>
  );
}

function Billing({ ctx }: { ctx: FinanceContext }) {
  const chargeTypes = useApiQuery<{ data: ChargeTypeDto[] }>(`${ctx.financePath}/charge-types`);
  const canManage = ctx.can('property.finance.manage');
  if (chargeTypes.status === 'loading') return <LoadingState label="Loading charge types" />;
  if (chargeTypes.status === 'error')
    return <ErrorState error={chargeTypes.error} onRetry={chargeTypes.reload} />;
  if (chargeTypes.data.data.length === 0) {
    return (
      <Card title="Finance is not set up">
        <p>
          Set up finance first: it creates the accounts and the standard charge types.{' '}
          <Link href={ctx.financePath}>Go to the finance overview</Link>
        </p>
      </Card>
    );
  }
  const types = chargeTypes.data.data;
  return (
    <>
      {canManage ? <BillingRun ctx={ctx} /> : null}
      <RecurringCharges ctx={ctx} chargeTypes={types} canManage={canManage} />
      <ChargeTypes
        ctx={ctx}
        chargeTypes={types}
        canManage={canManage}
        onChanged={chargeTypes.reload}
      />
    </>
  );
}

const SKIP_REASONS: Record<BillingRunResponse['skipped'][number]['reason'], string> = {
  NO_AREA: 'the unit has no area for a per-square-metre charge',
  NO_OWNER: 'nobody to bill: record its owners',
};

function BillingRun({ ctx }: { ctx: FinanceContext }) {
  const run = useAction();
  const today = todayIn(ctx.property.timeZone);
  const [result, setResult] = useState<BillingRunResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Card title="Run monthly billing">
      <p className="muted">
        Bills every active unit once for each recurring charge in the month: one invoice per unit
        and party. Running it again only bills what is missing.
      </p>
      <form
        className="form form--inline"
        noValidate
        aria-label="Run monthly billing"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const month = String(form.get('month') ?? '');
          const dueDate = String(form.get('dueDate') ?? '');
          if (!/^\d{4}-\d{2}$/.test(month)) return setProblem('Choose the month to bill.');
          if (!dueDate) return setProblem('Choose a due date.');
          setProblem(null);
          setResult(null);
          const body: BillingRunRequest = { month, dueDate, issue: form.get('issue') === 'on' };
          void run.run(async () => {
            setResult(await api.post<BillingRunResponse>(`${ctx.financePath}/billing-runs`, body));
          });
        }}
      >
        {problem ? <Alert>{problem}</Alert> : null}
        {run.error ? <Alert>{errorMessage(run.error)}</Alert> : null}
        {result ? (
          <Alert tone="success" title={`${formatMonth(result.month)} billed`}>
            {result.invoices.length === 0
              ? 'No new invoices: everything due this month is already billed.'
              : `${result.invoices.length} ${result.invoices.length === 1 ? 'invoice' : 'invoices'} created${
                  result.invoices[0]?.status === 'DRAFT'
                    ? ' as drafts to check and issue'
                    : ' and issued'
                }. `}
            <Link href={`${ctx.financePath}/invoices`}>See the invoices</Link>
            {result.skipped.length > 0 ? (
              <ul aria-label="Not billed">
                {result.skipped.map((s) => (
                  <li key={`${s.unitId}-${s.chargeTypeCode}`}>
                    Unit {s.unitNumber}, {s.chargeTypeCode}: {SKIP_REASONS[s.reason]}
                  </li>
                ))}
              </ul>
            ) : null}
          </Alert>
        ) : null}
        <TextField label="Month" name="month" type="month" defaultValue={today.slice(0, 7)} />
        <TextField
          label="Due date"
          name="dueDate"
          type="date"
          defaultValue={addDays(`${today.slice(0, 7)}-01`, 14)}
        />
        <CheckboxField
          label="Issue at once"
          name="issue"
          hint="Leave unticked to review the drafts first."
        />
        <Button type="submit" busy={run.busy}>
          Run billing
        </Button>
      </form>
    </Card>
  );
}

function RecurringCharges({
  ctx,
  chargeTypes,
  canManage,
}: {
  ctx: FinanceContext;
  chargeTypes: ChargeTypeDto[];
  canManage: boolean;
}) {
  const charges = useApiQuery<{ data: RecurringChargeDto[] }>(
    `${ctx.financePath}/recurring-charges`,
  );
  const units = useApiQuery<Paginated<UnitDto>>(`${ctx.propertyPath}/units?limit=200`);
  const create = useAction();
  const end = useAction();
  const [ending, setEnding] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const rows = charges.status === 'success' ? charges.data.data : [];
  const today = todayIn(ctx.property.timeZone);

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    const found: Record<string, string> = {};
    if (!text('chargeTypeId')) found.chargeTypeId = 'Choose a charge type.';
    const amount = parseAmount(text('amount'), ctx.property.currency);
    if (!amount.ok) found.amount = amount.error;
    if (!text('startMonth')) found.startMonth = 'Choose the first month.';
    if (text('endMonth') && text('endMonth') < text('startMonth'))
      found.endMonth = 'The last month cannot be before the first.';
    setProblems(found);
    if (Object.keys(found).length > 0 || !amount.ok) return;
    const body: CreateRecurringChargeRequest = {
      chargeTypeId: text('chargeTypeId'),
      basis: text('basis') === 'PER_SQM' ? 'PER_SQM' : 'FLAT',
      amount: amount.value,
      startMonth: text('startMonth'),
      ...(text('unitId') ? { unitId: text('unitId') } : {}),
      ...(text('endMonth') ? { endMonth: text('endMonth') } : {}),
    };
    void create
      .run(() => api.post(`${ctx.financePath}/recurring-charges`, body))
      .then((ok) => {
        if (!ok) return;
        formElement.reset();
        charges.reload();
      });
  }

  const serverFields = fieldErrors(create.error);
  return (
    <Card title="Recurring charges">
      <p className="muted">
        Monthly charges billed by the billing run: a flat amount per unit, or a rate per square
        metre of the unit's area. A charge for one unit replaces the property-wide charge of the
        same type.
      </p>
      {end.error ? <Alert>{errorMessage(end.error)}</Alert> : null}
      {charges.status === 'loading' ? <LoadingState label="Loading recurring charges" /> : null}
      {charges.status === 'error' ? (
        <ErrorState error={charges.error} onRetry={charges.reload} />
      ) : null}
      {charges.status === 'success' && rows.length === 0 ? (
        <p className="muted">No recurring charges yet.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Recurring charges">
          {rows.map((c) => (
            <li key={c.id} className="list__item">
              <div>
                <p className="list__primary">
                  {c.chargeTypeCode}{' '}
                  <span className="muted">
                    {c.unitNumber ? `unit ${c.unitNumber}` : 'every unit'} · {formatMoney(c.amount)}
                    {c.basis === 'PER_SQM' ? ' per m²' : ' a month'}
                  </span>
                </p>
                <p className="list__meta">
                  From {formatMonth(c.startMonth)}
                  {c.endMonth ? ` to ${formatMonth(c.endMonth)}` : ', no end'}
                </p>
              </div>
              {canManage && ending !== c.id ? (
                <Button
                  variant="secondary"
                  aria-label={`End ${c.chargeTypeCode} for ${c.unitNumber ? `unit ${c.unitNumber}` : 'every unit'}`}
                  onClick={() => setEnding(c.id)}
                >
                  End
                </Button>
              ) : null}
              {ending === c.id ? (
                <form
                  className="form form--compact"
                  noValidate
                  aria-label={`End ${c.chargeTypeCode}`}
                  onSubmit={(event: FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    const endMonth = String(
                      new FormData(event.currentTarget).get('endMonth') ?? '',
                    );
                    if (!endMonth) return;
                    void end
                      .run(() =>
                        api.post(`${ctx.financePath}/recurring-charges/${c.id}/end`, { endMonth }),
                      )
                      .then((ok) => {
                        if (!ok) return;
                        setEnding(null);
                        charges.reload();
                      });
                  }}
                >
                  <TextField
                    label="Last month billed"
                    name="endMonth"
                    type="month"
                    min={c.startMonth}
                    defaultValue={c.endMonth ?? today.slice(0, 7)}
                  />
                  <Button type="submit" busy={end.busy}>
                    Save
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
          onSubmit={onCreate}
          noValidate
          aria-label="New recurring charge"
        >
          <h3 className="form__full section-title">New recurring charge</h3>
          {create.error ? <Alert>{errorMessage(create.error)}</Alert> : null}
          <SelectField label="Applies to" name="unitId" defaultValue="">
            <option value="">Every unit</option>
            {units.status === 'success'
              ? units.data.data.map((u) => (
                  <option key={u.id} value={u.id}>
                    Unit {u.number}
                  </option>
                ))
              : null}
          </SelectField>
          <SelectField
            label="Charge type"
            name="chargeTypeId"
            defaultValue=""
            error={problems.chargeTypeId ?? serverFields.chargeTypeId}
          >
            <option value="">Choose a charge type</option>
            {chargeTypes
              .filter((t) => t.status === 'ACTIVE')
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.code})
                </option>
              ))}
          </SelectField>
          <SelectField label="Basis" name="basis" defaultValue="FLAT">
            <option value="FLAT">Flat amount a month</option>
            <option value="PER_SQM">Rate per square metre</option>
          </SelectField>
          <TextField
            label={`Amount (${ctx.property.currency})`}
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            error={problems.amount ?? serverFields.amount}
          />
          <TextField
            label="First month"
            name="startMonth"
            type="month"
            defaultValue={today.slice(0, 7)}
            error={problems.startMonth ?? serverFields.startMonth}
          />
          <TextField
            label="Last month (optional)"
            name="endMonth"
            type="month"
            error={problems.endMonth ?? serverFields.endMonth}
          />
          <Button type="submit" busy={create.busy}>
            Add charge
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

function ChargeTypes({
  ctx,
  chargeTypes,
  canManage,
  onChanged,
}: {
  ctx: FinanceContext;
  chargeTypes: ChargeTypeDto[];
  canManage: boolean;
  onChanged(): void;
}) {
  const accounts = useApiQuery<{ data: LedgerAccountDto[] }>(`${ctx.financePath}/accounts`);
  const create = useAction();
  const archive = useAction();
  const [problems, setProblems] = useState<Record<string, string>>({});
  const income =
    accounts.status === 'success'
      ? accounts.data.data.filter((a) => a.type === 'INCOME' && a.status === 'ACTIVE')
      : [];
  const accountName = (id: string) =>
    accounts.status === 'success' ? (accounts.data.data.find((a) => a.id === id)?.name ?? '') : '';

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    const found: Record<string, string> = {};
    if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(text('code').toUpperCase()))
      found.code = 'Use 2 to 20 letters, digits and hyphens.';
    if (!text('name')) found.name = 'Enter a name.';
    if (!text('incomeAccountId')) found.incomeAccountId = 'Choose an income account.';
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    const body: CreateChargeTypeRequest = {
      code: text('code').toUpperCase(),
      name: text('name'),
      liableParty: text('liableParty') as ChargeLiableParty,
      incomeAccountId: text('incomeAccountId'),
    };
    void create
      .run(() => api.post(`${ctx.financePath}/charge-types`, body))
      .then((ok) => {
        if (!ok) return;
        formElement.reset();
        onChanged();
      });
  }

  const serverFields = fieldErrors(create.error);
  return (
    <Card title="Charge types">
      {archive.error ? <Alert>{errorMessage(archive.error)}</Alert> : null}
      <ul className="list" aria-label="Charge types">
        {chargeTypes.map((t) => (
          <li key={t.id} className="list__item">
            <div>
              <p className="list__primary">
                {t.name} <span className="muted">({t.code})</span>
                {t.status === 'ARCHIVED' ? <span className="muted"> · archived</span> : null}
              </p>
              <p className="list__meta">
                Billed to: {LIABLE_PARTY_LABELS[t.liableParty]}
                {accountName(t.incomeAccountId)
                  ? ` · income: ${accountName(t.incomeAccountId)}`
                  : ''}
              </p>
            </div>
            {canManage && t.status === 'ACTIVE' ? (
              <Button
                variant="danger"
                busy={archive.busy}
                aria-label={`Archive ${t.name}`}
                onClick={() => {
                  if (!window.confirm(`Archive ${t.name}? It can no longer be billed.`)) return;
                  void archive
                    .run(() => api.post(`${ctx.financePath}/charge-types/${t.id}/archive`))
                    .then((ok) => ok && onChanged());
                }}
              >
                Archive
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {canManage ? (
        <form
          className="form form--inline"
          onSubmit={onCreate}
          noValidate
          aria-label="New charge type"
        >
          <h3 className="form__full section-title">New charge type</h3>
          {create.error ? <Alert>{errorMessage(create.error)}</Alert> : null}
          <TextField
            label="Code"
            name="code"
            maxLength={20}
            autoComplete="off"
            hint="e.g. PARKING"
            error={problems.code ?? serverFields.code}
          />
          <TextField
            label="Name"
            name="name"
            maxLength={120}
            error={problems.name ?? serverFields.name}
          />
          <SelectField label="Billed to" name="liableParty" defaultValue="OWNERS">
            <option value="OWNERS">{LIABLE_PARTY_LABELS.OWNERS}</option>
            <option value="OCCUPANT">{LIABLE_PARTY_LABELS.OCCUPANT}</option>
          </SelectField>
          <SelectField
            label="Income account"
            name="incomeAccountId"
            defaultValue=""
            error={problems.incomeAccountId ?? serverFields.incomeAccountId}
          >
            <option value="">Choose an account</option>
            {income.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </SelectField>
          <Button type="submit" busy={create.busy}>
            Add charge type
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
