'use client';

import type {
  ChargeTypeDto,
  CreateInvoiceRequest,
  InvoiceDetailDto,
  InvoiceDto,
  Paginated,
  UnitDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { type FinanceContext, FinanceFrame } from '@/components/finance-frame';
import {
  Alert,
  Badge,
  Button,
  Card,
  ErrorState,
  LoadingState,
  SelectField,
  TableWrap,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api-client';
import {
  addDays,
  formatMoney,
  formatMonth,
  INVOICE_STATE_TONES,
  invoiceState,
  PARTY_LABELS,
  parseAmount,
} from '@/lib/finance';
import { errorMessage, fieldErrors } from '@/lib/messages';
import { formatDate, todayIn } from '@/lib/residents';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';

export default function InvoicesPage() {
  return (
    <FinanceFrame section="invoices" title="Invoices">
      {(ctx) => (
        <>
          <InvoiceList ctx={ctx} />
          {ctx.can('property.finance.manage') ? <NewInvoice ctx={ctx} /> : null}
        </>
      )}
    </FinanceFrame>
  );
}

function useUnits(ctx: FinanceContext) {
  return useApiQuery<Paginated<UnitDto>>(`${ctx.propertyPath}/units?limit=200`);
}

function InvoiceList({ ctx }: { ctx: FinanceContext }) {
  const units = useUnits(ctx);
  const [status, setStatus] = useState('');
  const [unitId, setUnitId] = useState('');
  const [month, setMonth] = useState('');
  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (unitId) query.set('unitId', unitId);
  if (month) query.set('billingMonth', month);
  const search = query.toString();
  const invoices = useApiQuery<{ data: InvoiceDto[] }>(
    `${ctx.financePath}/invoices${search ? `?${search}` : ''}`,
  );
  const rows = invoices.status === 'success' ? invoices.data.data : [];
  return (
    <Card title="All invoices">
      <div className="form form--inline">
        <SelectField
          label="Status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">Any</option>
          <option value="DRAFT">Drafts</option>
          <option value="ISSUED">Issued</option>
        </SelectField>
        <SelectField
          label="Unit"
          value={unitId}
          onChange={(event) => setUnitId(event.target.value)}
        >
          <option value="">All units</option>
          {units.status === 'success'
            ? units.data.data.map((u) => (
                <option key={u.id} value={u.id}>
                  Unit {u.number}
                </option>
              ))
            : null}
        </SelectField>
        <TextField
          label="Billing month"
          type="month"
          value={month}
          onChange={(event) => setMonth(event.target.value)}
        />
      </div>
      {invoices.status === 'loading' ? <LoadingState label="Loading invoices" /> : null}
      {invoices.status === 'error' ? (
        <ErrorState error={invoices.error} onRetry={invoices.reload} />
      ) : null}
      {invoices.status === 'success' && rows.length === 0 ? (
        <p className="muted">
          {search
            ? 'No invoices match these filters.'
            : 'No invoices yet. Run billing or create one below.'}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <>
          <TableWrap label="Invoices">
            <table className="table">
              <caption className="visually-hidden">Invoices</caption>
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col">Unit</th>
                  <th scope="col">Bill to</th>
                  <th scope="col">Due</th>
                  <th scope="col" className="num">
                    Total
                  </th>
                  <th scope="col" className="num">
                    Outstanding
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => {
                  const state = invoiceState(i);
                  return (
                    <tr key={i.id}>
                      <td>
                        <Link href={`${ctx.financePath}/invoices/${i.id}`}>
                          {i.number ?? 'Draft'}
                        </Link>
                        {i.billingMonth ? (
                          <span className="muted"> · {formatMonth(i.billingMonth)}</span>
                        ) : null}
                      </td>
                      <td>{i.unitNumber}</td>
                      <td>{PARTY_LABELS[i.billTo]}</td>
                      <td>{formatDate(i.dueDate)}</td>
                      <td className="num">{formatMoney(i.total)}</td>
                      <td className="num">
                        {i.status === 'DRAFT' ? '—' : formatMoney(i.outstanding)}
                      </td>
                      <td>
                        <Badge tone={INVOICE_STATE_TONES[state]}>{state}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
          {rows.length === 200 ? (
            <p className="muted">Showing the 200 most recent. Filter to see older invoices.</p>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

/** A one-off draft invoice with one line (e.g. a key replacement). It is issued from its page. */
function NewInvoice({ ctx }: { ctx: FinanceContext }) {
  const router = useRouter();
  const units = useUnits(ctx);
  const chargeTypes = useApiQuery<{ data: ChargeTypeDto[] }>(`${ctx.financePath}/charge-types`);
  const create = useAction();
  const [problems, setProblems] = useState<Record<string, string>>({});
  const today = todayIn(ctx.property.timeZone);
  const active =
    chargeTypes.status === 'success'
      ? chargeTypes.data.data.filter((c) => c.status === 'ACTIVE')
      : [];

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    const found: Record<string, string> = {};
    if (!text('unitId')) found.unitId = 'Choose a unit.';
    if (!text('chargeTypeId')) found.chargeTypeId = 'Choose a charge type.';
    const amount = parseAmount(text('amount'), ctx.property.currency);
    if (!amount.ok) found.amount = amount.error;
    if (!text('dueDate')) found.dueDate = 'Choose a due date.';
    setProblems(found);
    if (Object.keys(found).length > 0 || !amount.ok) return;
    const body: CreateInvoiceRequest = {
      unitId: text('unitId'),
      dueDate: text('dueDate'),
      lines: [
        {
          chargeTypeId: text('chargeTypeId'),
          amount: amount.value,
          ...(text('description') ? { description: text('description') } : {}),
        },
      ],
    };
    let created: InvoiceDetailDto | undefined;
    const ok = await create.run(async () => {
      created = await api.post<InvoiceDetailDto>(`${ctx.financePath}/invoices`, body);
    });
    if (ok && created) router.push(`${ctx.financePath}/invoices/${created.id}`);
  }

  const serverFields = fieldErrors(create.error);
  return (
    <Card title="New one-off invoice">
      <p className="muted">
        For a single charge outside the monthly billing, such as a replacement access card. It is
        saved as a draft for you to check and issue.
      </p>
      {chargeTypes.status === 'error' ? (
        <ErrorState error={chargeTypes.error} onRetry={chargeTypes.reload} />
      ) : null}
      <form className="form form--inline" onSubmit={onSubmit} noValidate aria-label="New invoice">
        {create.error ? <Alert>{errorMessage(create.error)}</Alert> : null}
        <SelectField label="Unit" name="unitId" defaultValue="" error={problems.unitId}>
          <option value="">Choose a unit</option>
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
          error={problems.chargeTypeId ?? serverFields['lines.0.chargeTypeId']}
        >
          <option value="">Choose a charge type</option>
          {active.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.code})
            </option>
          ))}
        </SelectField>
        <TextField
          label="Description (optional)"
          name="description"
          maxLength={200}
          error={serverFields['lines.0.description']}
        />
        <TextField
          label={`Amount (${ctx.property.currency})`}
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          error={problems.amount ?? serverFields['lines.0.amount']}
        />
        <TextField
          label="Due date"
          name="dueDate"
          type="date"
          min={today}
          defaultValue={addDays(today, 14)}
          error={problems.dueDate ?? serverFields.dueDate}
        />
        <Button type="submit" busy={create.busy}>
          Save draft
        </Button>
      </form>
    </Card>
  );
}
