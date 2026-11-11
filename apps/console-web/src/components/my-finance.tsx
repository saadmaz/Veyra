'use client';

import type {
  BankTransferDto,
  InvoiceDto,
  MyFinanceAccountDto,
  MyFinanceDto,
  PaymentDto,
  StatementDto,
  SubmitBankTransferRequest,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { type FormEvent, useRef, useState } from 'react';
import { ApiRequestError, api } from '@/lib/api-client';
import {
  ACCOUNT_LABELS,
  balanceText,
  canDiscardIdempotencyKey,
  formatMoney,
  INVOICE_STATE_TONES,
  invoiceState,
  isPositive,
  PAYMENT_METHOD_LABELS,
  parseAmount,
  STATEMENT_KIND_LABELS,
  TRANSFER_STATUS_LABELS,
  TRANSFER_STATUS_TONES,
} from '@/lib/finance';
import { errorMessage, fieldErrors } from '@/lib/messages';
import { formatDate } from '@/lib/residents';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  TableWrap,
  TextField,
} from './ui';

/*
 * A resident's own account(s) of a unit (Phase 6 Part 6): what they owe, their invoices,
 * receipts and statement, and bank transfers they told finance about. The API returns only the
 * caller's own account — an owner the owners', a tenant their tenancy's — and checks every
 * request; nothing here decides access.
 */

type PaidBy = MyFinanceAccountDto['paidBy'];

export function MyFinance({
  unitPath,
  canPay,
}: {
  /** Console path of the unit, which is also its API path. */
  unitPath: string;
  canPay: boolean;
}) {
  const base = `${unitPath}/my-finance`;
  const summary = useApiQuery<MyFinanceDto>(base);
  const [chosen, setChosen] = useState<PaidBy | null>(null);
  // Bumped after a submission so the lists and the summary load again.
  const [version, setVersion] = useState(0);

  if (summary.status === 'loading') return <LoadingState label="Loading your account" />;
  if (summary.status === 'error') {
    // The unit is visible to you, but you are not one of its owners or current tenants.
    if (summary.error instanceof ApiRequestError && summary.error.status === 404) {
      return (
        <EmptyState title="No account of yours here">
          Billing shows the account of the unit's owners to its owners, and a tenancy's account to
          its tenants. You are neither on this unit today.
        </EmptyState>
      );
    }
    return <ErrorState error={summary.error} onRetry={summary.reload} />;
  }
  const s = summary.data;
  const account = s.accounts.find((a) => a.paidBy === chosen) ?? s.accounts[0];
  if (!account) return null;
  const refresh = () => {
    summary.reload();
    setVersion((v) => v + 1);
  };

  return (
    <>
      {s.accounts.length > 1 ? (
        <nav aria-label="Your accounts">
          <ul className="subnav">
            {s.accounts.map((a) => (
              <li key={a.paidBy}>
                <button
                  type="button"
                  aria-pressed={a.paidBy === account.paidBy}
                  onClick={() => setChosen(a.paidBy)}
                >
                  {ACCOUNT_LABELS[a.paidBy]}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <Card title={ACCOUNT_LABELS[account.paidBy]}>
        <dl className="details">
          <div>
            <dt>Balance on {formatDate(s.asOf)}</dt>
            <dd>{balanceText(account.balance)}</dd>
          </div>
          <div>
            <dt>Overdue</dt>
            <dd>
              {isPositive(account.overdue) ? formatMoney(account.overdue) : 'Nothing overdue'}
            </dd>
          </div>
          <div>
            <dt>Transfers waiting for finance</dt>
            <dd>
              {isPositive(account.pendingTransfers)
                ? formatMoney(account.pendingTransfers)
                : 'None'}
            </dd>
          </div>
        </dl>
        <p className="muted">
          {account.paidBy === 'OWNERS'
            ? 'Shared by the owners of this unit. Tenants do not see it.'
            : 'For your tenancy only. The owners do not see it.'}
        </p>
      </Card>
      <MyInvoices key={`i-${account.paidBy}-${version}`} base={base} paidBy={account.paidBy} />
      {canPay ? (
        <ReportTransfer
          base={base}
          paidBy={account.paidBy}
          currency={s.currency}
          today={s.asOf}
          onSubmitted={refresh}
        />
      ) : null}
      <MyTransfers key={`t-${version}`} base={base} paidBy={account.paidBy} />
      <MyReceipts key={`r-${account.paidBy}-${version}`} base={base} paidBy={account.paidBy} />
      <MyStatement key={`s-${account.paidBy}-${version}`} base={base} paidBy={account.paidBy} />
    </>
  );
}

function MyInvoices({ base, paidBy }: { base: string; paidBy: PaidBy }) {
  const invoices = useApiQuery<{ data: InvoiceDto[] }>(`${base}/invoices?paidBy=${paidBy}`);
  const rows = invoices.status === 'success' ? invoices.data.data : [];
  // The console's invoice page lives under the unit's billing page.
  const pagePath = base.replace(/\/my-finance$/, '/billing');
  return (
    <Card title="Invoices">
      {invoices.status === 'loading' ? <LoadingState label="Loading invoices" /> : null}
      {invoices.status === 'error' ? (
        <ErrorState error={invoices.error} onRetry={invoices.reload} />
      ) : null}
      {invoices.status === 'success' && rows.length === 0 ? (
        <p className="muted">No invoices yet.</p>
      ) : null}
      {rows.length > 0 ? (
        <TableWrap label="Your invoices">
          <table className="table">
            <caption className="visually-hidden">Your invoices</caption>
            <thead>
              <tr>
                <th scope="col">Invoice</th>
                <th scope="col">Issued</th>
                <th scope="col">Due</th>
                <th scope="col" className="num">
                  Total
                </th>
                <th scope="col" className="num">
                  Still to pay
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
                      <Link href={`${pagePath}/invoices/${i.id}`}>{i.number}</Link>
                    </td>
                    <td>{i.issueDate ? formatDate(i.issueDate) : '—'}</td>
                    <td>{formatDate(i.dueDate)}</td>
                    <td className="num">{formatMoney(i.total)}</td>
                    <td className="num">{formatMoney(i.outstanding)}</td>
                    <td>
                      <Badge tone={INVOICE_STATE_TONES[state]}>{state}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      ) : null}
    </Card>
  );
}

function MyReceipts({ base, paidBy }: { base: string; paidBy: PaidBy }) {
  const payments = useApiQuery<{ data: PaymentDto[] }>(`${base}/payments?paidBy=${paidBy}`);
  const rows = payments.status === 'success' ? payments.data.data : [];
  return (
    <Card title="Receipts">
      {payments.status === 'loading' ? <LoadingState label="Loading receipts" /> : null}
      {payments.status === 'error' ? (
        <ErrorState error={payments.error} onRetry={payments.reload} />
      ) : null}
      {payments.status === 'success' && rows.length === 0 ? (
        <p className="muted">No payments recorded yet.</p>
      ) : null}
      {rows.length > 0 ? (
        <TableWrap label="Your receipts">
          <table className="table">
            <caption className="visually-hidden">Your receipts</caption>
            <thead>
              <tr>
                <th scope="col">Receipt</th>
                <th scope="col">Received</th>
                <th scope="col">Method</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col">Paid</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.receiptNumber}
                    {p.reversedOn ? (
                      <>
                        {' '}
                        <Badge tone="danger">reversed</Badge>
                      </>
                    ) : null}
                  </td>
                  <td>{formatDate(p.receivedOn)}</td>
                  <td>
                    {PAYMENT_METHOD_LABELS[p.method]}
                    {p.reference ? <span className="muted"> · {p.reference}</span> : null}
                  </td>
                  <td className="num">{formatMoney(p.amount)}</td>
                  <td>
                    {p.allocations
                      .filter((a) => a.releasedAt === null)
                      .map((a) => a.invoiceNumber)
                      .filter(Boolean)
                      .join(', ') || 'Kept as credit'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : null}
    </Card>
  );
}

function MyStatement({ base, paidBy }: { base: string; paidBy: PaidBy }) {
  const statement = useApiQuery<StatementDto>(`${base}/statement?paidBy=${paidBy}`);
  return (
    <Card title="Statement">
      {statement.status === 'loading' ? <LoadingState label="Loading statement" /> : null}
      {statement.status === 'error' ? (
        <ErrorState error={statement.error} onRetry={statement.reload} />
      ) : null}
      {statement.status === 'success' && statement.data.lines.length === 0 ? (
        <p className="muted">Nothing has been billed or paid yet.</p>
      ) : null}
      {statement.status === 'success' && statement.data.lines.length > 0 ? (
        <TableWrap label="Your statement">
          <table className="table">
            <caption className="visually-hidden">Your statement</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Entry</th>
                <th scope="col" className="num">
                  Charged
                </th>
                <th scope="col" className="num">
                  Paid or credited
                </th>
                <th scope="col" className="num">
                  Balance
                </th>
              </tr>
            </thead>
            <tbody>
              {statement.data.lines.map((l, index) => (
                // Lines have no id; their order is the statement.
                // biome-ignore lint/suspicious/noArrayIndexKey: stable, append-only order.
                <tr key={index}>
                  <td>{formatDate(l.date)}</td>
                  <td>
                    {STATEMENT_KIND_LABELS[l.kind]} <span className="muted">{l.reference}</span>
                  </td>
                  <td className="num">{isPositive(l.debit) ? formatMoney(l.debit) : ''}</td>
                  <td className="num">{isPositive(l.credit) ? formatMoney(l.credit) : ''}</td>
                  <td className="num">{formatMoney(l.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : null}
    </Card>
  );
}

function MyTransfers({ base, paidBy }: { base: string; paidBy: PaidBy }) {
  const transfers = useApiQuery<{ data: BankTransferDto[] }>(`${base}/bank-transfers`);
  const rows =
    transfers.status === 'success' ? transfers.data.data.filter((t) => t.paidBy === paidBy) : [];
  return (
    <Card title="Bank transfers you reported">
      {transfers.status === 'loading' ? <LoadingState label="Loading transfers" /> : null}
      {transfers.status === 'error' ? (
        <ErrorState error={transfers.error} onRetry={transfers.reload} />
      ) : null}
      {transfers.status === 'success' && rows.length === 0 ? (
        <p className="muted">You have not reported any bank transfers for this account.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Bank transfers you reported">
          {rows.map((t) => (
            <li key={t.id} className="list__item">
              <div>
                <p className="list__primary">
                  {formatMoney(t.amount)} on {formatDate(t.transferredOn)}{' '}
                  <Badge tone={TRANSFER_STATUS_TONES[t.status]}>
                    {TRANSFER_STATUS_LABELS[t.status]}
                  </Badge>
                </p>
                <p className="list__meta">
                  Reference {t.reference} · reported by {t.submittedBy.name}
                  {t.receiptNumber ? ` · receipt ${t.receiptNumber}` : ''}
                </p>
                {t.rejectionReason ? (
                  <p className="list__meta">Finance: {t.rejectionReason}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function ReportTransfer({
  base,
  paidBy,
  currency,
  today,
  onSubmitted,
}: {
  base: string;
  paidBy: PaidBy;
  currency: string;
  today: string;
  onSubmitted(): void;
}) {
  const submit = useAction();
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [done, setDone] = useState<BankTransferDto | null>(null);
  // One key per transfer being reported, kept for a retry (see canDiscardIdempotencyKey).
  const idempotencyKey = useRef<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    const found: Record<string, string> = {};
    const amount = parseAmount(text('amount'), currency);
    if (!amount.ok) found.amount = amount.error;
    if (!text('transferredOn')) found.transferredOn = 'Enter the date you sent the money.';
    else if (text('transferredOn') > today) found.transferredOn = 'This date is in the future.';
    if (!text('reference')) found.reference = "Enter the bank's reference for the transfer.";
    setProblems(found);
    if (Object.keys(found).length > 0 || !amount.ok) return;
    const body: SubmitBankTransferRequest = {
      paidBy,
      amount: amount.value,
      transferredOn: text('transferredOn'),
      reference: text('reference'),
      ...(text('note') ? { note: text('note') } : {}),
    };
    idempotencyKey.current ??= crypto.randomUUID();
    const key = idempotencyKey.current;
    setDone(null);
    let created: BankTransferDto | undefined;
    const ok = await submit.run(async () => {
      try {
        created = await api.post<BankTransferDto>(`${base}/bank-transfers`, body, {
          headers: { 'Idempotency-Key': key },
        });
      } catch (error) {
        if (canDiscardIdempotencyKey(error)) idempotencyKey.current = null;
        throw error;
      }
    });
    if (!ok || !created) return;
    idempotencyKey.current = null;
    formElement.reset();
    setDone(created);
    onSubmitted();
  }

  const errors = { ...fieldErrors(submit.error), ...problems };
  return (
    <Card title="Tell finance about a bank transfer">
      <p className="muted">
        Paid by bank transfer? Give the bank's reference and finance will confirm it once the money
        arrives. Your balance changes when it is confirmed.
      </p>
      {done ? (
        <Alert tone="success">
          Thank you. Your transfer of {formatMoney(done.amount)} is waiting for finance to confirm
          it.
        </Alert>
      ) : null}
      {submit.error && Object.keys(fieldErrors(submit.error)).length === 0 ? (
        <Alert>{errorMessage(submit.error)}</Alert>
      ) : null}
      <form className="form" noValidate onSubmit={onSubmit} aria-label="Report a bank transfer">
        <TextField
          label={`Amount (${currency})`}
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          required
          error={errors.amount}
        />
        <TextField
          label="Date sent"
          name="transferredOn"
          type="date"
          max={today}
          defaultValue={today}
          required
          error={errors.transferredOn}
        />
        <TextField
          label="Bank reference"
          name="reference"
          maxLength={100}
          autoComplete="off"
          hint="As shown in your bank app or on the transfer slip."
          required
          error={errors.reference}
        />
        <TextField
          label="Note for finance (optional)"
          name="note"
          maxLength={500}
          error={errors.note}
        />
        <Button type="submit" busy={submit.busy}>
          Send to finance
        </Button>
      </form>
    </Card>
  );
}
