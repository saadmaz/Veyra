'use client';

import type { Paginated, PaymentDto, RecordPaymentRequest, UnitDto } from '@veyra/api-contracts';
import Link from 'next/link';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
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
  canDiscardIdempotencyKey,
  formatMoney,
  isPositive,
  MANUAL_PAYMENT_METHODS,
  PARTY_LABELS,
  PAYMENT_METHOD_LABELS,
  parseAmount,
} from '@/lib/finance';
import { errorMessage, fieldErrors } from '@/lib/messages';
import { formatDate, todayIn } from '@/lib/residents';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';

export default function PaymentsPage() {
  return (
    <FinanceFrame section="payments" title="Payments">
      {(ctx) => <Payments ctx={ctx} />}
    </FinanceFrame>
  );
}

/** Prefill from a link such as "Record a payment" on an invoice (?unitId=…&paidBy=…). */
function readPrefill(): { unitId: string; paidBy: 'OWNERS' | 'TENANTS' } {
  const params = new URLSearchParams(window.location.search);
  return {
    unitId: params.get('unitId') ?? '',
    paidBy: params.get('paidBy') === 'TENANTS' ? 'TENANTS' : 'OWNERS',
  };
}

function Payments({ ctx }: { ctx: FinanceContext }) {
  const units = useApiQuery<Paginated<UnitDto>>(`${ctx.propertyPath}/units?limit=200`);
  const [unitFilter, setUnitFilter] = useState('');
  const payments = useApiQuery<{ data: PaymentDto[] }>(
    `${ctx.financePath}/payments${unitFilter ? `?unitId=${unitFilter}` : ''}`,
  );
  const unitOptions =
    units.status === 'success'
      ? units.data.data.map((u) => (
          <option key={u.id} value={u.id}>
            Unit {u.number}
          </option>
        ))
      : null;
  const rows = payments.status === 'success' ? payments.data.data : [];
  return (
    <>
      {ctx.can('property.finance.manage') ? (
        <RecordPayment ctx={ctx} unitOptions={unitOptions} onRecorded={payments.reload} />
      ) : null}
      <Card title="Receipts">
        <div className="form form--inline">
          <SelectField
            label="Unit"
            value={unitFilter}
            onChange={(event) => setUnitFilter(event.target.value)}
          >
            <option value="">All units</option>
            {unitOptions}
          </SelectField>
        </div>
        {payments.status === 'loading' ? <LoadingState label="Loading payments" /> : null}
        {payments.status === 'error' ? (
          <ErrorState error={payments.error} onRetry={payments.reload} />
        ) : null}
        {payments.status === 'success' && rows.length === 0 ? (
          <p className="muted">No payments recorded.</p>
        ) : null}
        {rows.length > 0 ? (
          <TableWrap label="Payments">
            <table className="table">
              <caption className="visually-hidden">Payments</caption>
              <thead>
                <tr>
                  <th scope="col">Receipt</th>
                  <th scope="col">Unit</th>
                  <th scope="col">Paid by</th>
                  <th scope="col">Received</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                  <th scope="col" className="num">
                    Unused
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`${ctx.financePath}/payments/${p.id}`}>{p.receiptNumber}</Link>
                      {p.reversedOn ? (
                        <>
                          {' '}
                          <Badge tone="danger">reversed</Badge>
                        </>
                      ) : null}
                    </td>
                    <td>{p.unitNumber}</td>
                    <td>
                      {PARTY_LABELS[p.paidBy]}{' '}
                      <span className="muted">({PAYMENT_METHOD_LABELS[p.method]})</span>
                    </td>
                    <td>{formatDate(p.receivedOn)}</td>
                    <td className="num">{formatMoney(p.amount)}</td>
                    <td className="num">{formatMoney(p.unallocated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        ) : null}
      </Card>
    </>
  );
}

function RecordPayment({
  ctx,
  unitOptions,
  onRecorded,
}: {
  ctx: FinanceContext;
  unitOptions: ReactNode;
  onRecorded(): void;
}) {
  const record = useAction();
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [recorded, setRecorded] = useState<PaymentDto | null>(null);
  const [prefill, setPrefill] = useState<{ unitId: string; paidBy: 'OWNERS' | 'TENANTS' } | null>(
    null,
  );
  // Controlled: the unit options load after the form appears, so a default value would be lost.
  const [unitId, setUnitId] = useState('');
  // One key per payment being entered; see canDiscardIdempotencyKey.
  const idempotencyKey = useRef<string | null>(null);
  const today = todayIn(ctx.property.timeZone);

  useEffect(() => {
    const initial = readPrefill();
    setPrefill(initial);
    setUnitId(initial.unitId);
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    const found: Record<string, string> = {};
    if (!text('unitId')) found.unitId = 'Choose a unit.';
    const amount = parseAmount(text('amount'), ctx.property.currency);
    if (!amount.ok) found.amount = amount.error;
    if (!text('receivedOn')) found.receivedOn = 'Enter the date the money was received.';
    else if (text('receivedOn') > today) found.receivedOn = 'This date is in the future.';
    setProblems(found);
    if (Object.keys(found).length > 0 || !amount.ok) return;
    const body: RecordPaymentRequest = {
      unitId: text('unitId'),
      paidBy: text('paidBy') === 'TENANTS' ? 'TENANTS' : 'OWNERS',
      method: text('method') as RecordPaymentRequest['method'],
      amount: amount.value,
      receivedOn: text('receivedOn'),
      ...(text('reference') ? { reference: text('reference') } : {}),
    };
    idempotencyKey.current ??= crypto.randomUUID();
    const key = idempotencyKey.current;
    setRecorded(null);
    let payment: PaymentDto | undefined;
    const ok = await record.run(async () => {
      try {
        payment = await api.post<PaymentDto>(`${ctx.financePath}/payments`, body, {
          headers: { 'Idempotency-Key': key },
        });
      } catch (error) {
        if (canDiscardIdempotencyKey(error)) idempotencyKey.current = null;
        throw error;
      }
    });
    if (!ok || !payment) return;
    idempotencyKey.current = null;
    setRecorded(payment);
    formElement.reset();
    setUnitId('');
    onRecorded();
  }

  const serverFields = fieldErrors(record.error);
  return (
    <Card title="Record a payment">
      <p className="muted">
        Money received by bank transfer, cash or cheque. It pays the party's oldest unpaid invoices
        first; anything left is kept as credit for their next invoices.
      </p>
      {recorded ? (
        <Alert tone="success" title={`Receipt ${recorded.receiptNumber} recorded`}>
          {formatMoney(recorded.allocated)} applied to invoices
          {isPositive(recorded.unallocated)
            ? `, ${formatMoney(recorded.unallocated)} kept as credit`
            : ''}
          . <Link href={`${ctx.financePath}/payments/${recorded.id}`}>Open the receipt</Link>
        </Alert>
      ) : null}
      {prefill ? (
        <form
          className="form form--inline"
          onSubmit={onSubmit}
          noValidate
          aria-label="Record a payment"
        >
          {record.error ? <Alert>{errorMessage(record.error)}</Alert> : null}
          <SelectField
            label="Unit"
            name="unitId"
            value={unitId}
            onChange={(event) => setUnitId(event.target.value)}
            error={problems.unitId ?? serverFields.unitId}
          >
            <option value="">Choose a unit</option>
            {unitOptions}
          </SelectField>
          <SelectField label="Paid by" name="paidBy" defaultValue={prefill.paidBy}>
            <option value="OWNERS">Owners</option>
            <option value="TENANTS">Tenants</option>
          </SelectField>
          <SelectField label="Method" name="method" defaultValue="BANK_TRANSFER">
            {MANUAL_PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </SelectField>
          <TextField
            label={`Amount (${ctx.property.currency})`}
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            error={problems.amount ?? serverFields.amount}
          />
          <TextField
            label="Received on"
            name="receivedOn"
            type="date"
            max={today}
            defaultValue={today}
            error={problems.receivedOn ?? serverFields.receivedOn}
          />
          <TextField
            label="Reference (optional)"
            name="reference"
            maxLength={100}
            autoComplete="off"
            hint="Bank reference or cheque number"
            error={serverFields.reference}
          />
          <Button type="submit" busy={record.busy}>
            Record payment
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
