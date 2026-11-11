'use client';

import type {
  CreateCreditNoteRequest,
  FinanceApprovalDto,
  FinanceApprovalRequest,
  InvoiceDetailDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { type FinanceContext, FinanceFrame } from '@/components/finance-frame';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  TableWrap,
  TextField,
} from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import {
  formatMoney,
  formatMonth,
  INVOICE_STATE_TONES,
  invoiceState,
  isPositive,
  laterDate,
  moneyInput,
  PARTY_LABELS,
  parseAmount,
} from '@/lib/finance';
import { errorMessage } from '@/lib/messages';
import { formatDate, todayIn } from '@/lib/residents';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';

export default function InvoicePage() {
  return (
    <FinanceFrame
      section="invoices"
      title="Invoice"
      crumb={{ label: 'Invoices', path: '/invoices' }}
    >
      {(ctx) => <Invoice ctx={ctx} />}
    </FinanceFrame>
  );
}

function Invoice({ ctx }: { ctx: FinanceContext }) {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const path = `${ctx.financePath}/invoices/${invoiceId}`;
  const invoice = useApiQuery<InvoiceDetailDto>(path);
  if (invoice.status === 'loading') return <LoadingState label="Loading the invoice" />;
  if (invoice.status === 'error') {
    if (invoice.error instanceof ApiRequestError && invoice.error.status === 404) {
      return (
        <EmptyState title="Invoice not found">
          It may have been a draft that was discarded.
        </EmptyState>
      );
    }
    return <ErrorState error={invoice.error} onRetry={invoice.reload} />;
  }
  const i = invoice.data;
  const state = invoiceState(i);
  const canManage = ctx.can('property.finance.manage');
  const owes = i.status === 'ISSUED' && isPositive(i.outstanding);
  return (
    <>
      <Card
        title={i.number ? `Invoice ${i.number}` : 'Draft invoice'}
        actions={<Badge tone={INVOICE_STATE_TONES[state]}>{state}</Badge>}
      >
        <dl className="details">
          <div>
            <dt>Unit</dt>
            <dd>{i.unitNumber}</dd>
          </div>
          <div>
            <dt>Bill to</dt>
            <dd>
              {PARTY_LABELS[i.billTo]}
              {i.recipients.length > 0 ? `: ${i.recipients.map((r) => r.fullName).join(', ')}` : ''}
            </dd>
          </div>
          {i.billingMonth ? (
            <div>
              <dt>Billing month</dt>
              <dd>{formatMonth(i.billingMonth)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Issued</dt>
            <dd>{i.issueDate ? formatDate(i.issueDate) : 'Not yet'}</dd>
          </div>
          <div>
            <dt>Due</dt>
            <dd>{formatDate(i.dueDate)}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd>{formatMoney(i.total)}</dd>
          </div>
          {i.status === 'ISSUED' ? (
            <>
              <div>
                <dt>Paid</dt>
                <dd>{formatMoney(i.paid)}</dd>
              </div>
              <div>
                <dt>Credited</dt>
                <dd>{formatMoney(i.credited)}</dd>
              </div>
              <div>
                <dt>Outstanding</dt>
                <dd>{formatMoney(i.outstanding)}</dd>
              </div>
            </>
          ) : null}
        </dl>
        {owes && canManage ? (
          <div className="form__actions">
            <ButtonLink
              href={`${ctx.financePath}/payments?unitId=${i.unitId}&paidBy=${i.billTo}`}
              variant="secondary"
            >
              Record a payment
            </ButtonLink>
          </div>
        ) : null}
      </Card>

      <Card title="Lines">
        <TableWrap label="Invoice lines">
          <table className="table">
            <caption className="visually-hidden">Invoice lines</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Description</th>
                <th scope="col">Charge</th>
                <th scope="col" className="num">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {i.lines.map((l) => (
                <tr key={l.lineNumber}>
                  <td>{l.lineNumber}</td>
                  <td>{l.description}</td>
                  <td>{l.chargeTypeCode}</td>
                  <td className="num">{formatMoney(l.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3}>
                  Total
                </th>
                <td className="num">{formatMoney(i.total)}</td>
              </tr>
            </tfoot>
          </table>
        </TableWrap>
      </Card>

      {i.credits.length > 0 ? (
        <Card title="Credit notes and write-offs">
          <ul className="list" aria-label="Credits">
            {i.credits.map((c) => (
              <li key={c.id} className="list__item">
                <div>
                  <p className="list__primary">
                    {c.kind === 'CREDIT_NOTE' ? `Credit note ${c.number}` : 'Write-off'}{' '}
                    <span className="muted">
                      {formatMoney(c.amount)} · {formatDate(c.creditedOn)}
                      {c.lineNumber ? ` · line ${c.lineNumber}` : ''}
                    </span>
                  </p>
                  <p className="list__meta">{c.reason}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {canManage && i.status === 'DRAFT' ? (
        <DraftActions ctx={ctx} invoice={i} onIssued={invoice.reload} />
      ) : null}
      {canManage && owes ? (
        <>
          <CreditNote ctx={ctx} invoice={i} onDone={invoice.reload} />
          {/* Remounts when the amount owed changes, so its suggested amount is current. */}
          <WriteOff key={i.outstanding.amountMinor} ctx={ctx} invoice={i} />
        </>
      ) : null}
    </>
  );
}

function DraftActions({
  ctx,
  invoice,
  onIssued,
}: {
  ctx: FinanceContext;
  invoice: InvoiceDetailDto;
  onIssued(): void;
}) {
  const router = useRouter();
  const issue = useAction();
  const discard = useAction();
  const today = todayIn(ctx.property.timeZone);
  const path = `${ctx.financePath}/invoices/${invoice.id}`;
  return (
    <Card title="Issue or discard">
      <p className="muted">
        Issuing gives the invoice its number and posts it to the ledger today. Issued invoices
        cannot be edited or deleted: correct them with a credit note.
      </p>
      {issue.error ? <Alert>{errorMessage(issue.error)}</Alert> : null}
      {discard.error ? <Alert>{errorMessage(discard.error)}</Alert> : null}
      <form
        className="form form--inline"
        noValidate
        aria-label="Issue invoice"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const dueDate = String(new FormData(event.currentTarget).get('dueDate') ?? '');
          void issue
            .run(() =>
              api.post(`${path}/issue`, dueDate && dueDate !== invoice.dueDate ? { dueDate } : {}),
            )
            .then((ok) => ok && onIssued());
        }}
      >
        <TextField
          label="Due date"
          name="dueDate"
          type="date"
          min={today}
          defaultValue={laterDate(invoice.dueDate, today)}
        />
        <Button type="submit" busy={issue.busy}>
          Issue invoice
        </Button>
        <Button
          variant="danger"
          busy={discard.busy}
          onClick={() => {
            if (!window.confirm('Discard this draft? It is deleted and cannot be recovered.'))
              return;
            void discard
              .run(() => api.post(`${path}/discard`))
              .then((ok) => ok && router.push(`${ctx.financePath}/invoices`));
          }}
        >
          Discard draft
        </Button>
      </form>
    </Card>
  );
}

function CreditNote({
  ctx,
  invoice,
  onDone,
}: {
  ctx: FinanceContext;
  invoice: InvoiceDetailDto;
  onDone(): void;
}) {
  const credit = useAction();
  const [problems, setProblems] = useState<Record<string, string>>({});
  return (
    <Card title="Credit note">
      <p className="muted">
        Reduces what this invoice asks for, for example a charge billed by mistake. It is numbered
        and takes effect at once. To credit money already paid, release the payment first.
      </p>
      <form
        className="form form--inline"
        noValidate
        aria-label="Credit note"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const formElement = event.currentTarget;
          const form = new FormData(formElement);
          const amount = parseAmount(String(form.get('amount') ?? ''), invoice.total.currency);
          const reason = String(form.get('reason') ?? '').trim();
          const found: Record<string, string> = {};
          if (!amount.ok) found.amount = amount.error;
          if (!reason) found.reason = 'Say why.';
          setProblems(found);
          if (!amount.ok || !reason) return;
          const body: CreateCreditNoteRequest = {
            lineNumber: Number(form.get('lineNumber')),
            amount: amount.value,
            reason,
          };
          void credit
            .run(() => api.post(`${ctx.financePath}/invoices/${invoice.id}/credit-notes`, body))
            .then((ok) => {
              if (!ok) return;
              formElement.reset();
              onDone();
            });
        }}
      >
        {credit.error ? <Alert>{errorMessage(credit.error)}</Alert> : null}
        <SelectField
          label="Line"
          name="lineNumber"
          defaultValue={String(invoice.lines[0]?.lineNumber ?? 1)}
        >
          {invoice.lines.map((l) => (
            <option key={l.lineNumber} value={l.lineNumber}>
              {l.lineNumber}. {l.description} ({formatMoney(l.amount)})
            </option>
          ))}
        </SelectField>
        <TextField
          label={`Amount (${invoice.total.currency})`}
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          error={problems.amount}
        />
        <TextField label="Reason" name="reason" maxLength={500} error={problems.reason} />
        <Button type="submit" variant="secondary" busy={credit.busy}>
          Issue credit note
        </Button>
      </form>
    </Card>
  );
}

function WriteOff({ ctx, invoice }: { ctx: FinanceContext; invoice: InvoiceDetailDto }) {
  const request = useAction();
  const [sent, setSent] = useState<FinanceApprovalDto | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  return (
    <Card title="Write off">
      <p className="muted">
        Gives up on money this invoice is owed, for example when it cannot be collected. Another
        finance officer or admin must approve it.
      </p>
      {sent ? (
        <Alert tone="success">
          Sent for approval. <Link href={`${ctx.financePath}/approvals`}>See the request</Link>
        </Alert>
      ) : null}
      <form
        className="form form--inline"
        noValidate
        aria-label="Write off"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const formElement = event.currentTarget;
          const form = new FormData(formElement);
          const amount = parseAmount(String(form.get('amount') ?? ''), invoice.total.currency);
          const reason = String(form.get('reason') ?? '').trim();
          const found: Record<string, string> = {};
          if (!amount.ok) found.amount = amount.error;
          if (!reason) found.reason = 'Say why.';
          setProblems(found);
          if (!amount.ok || !reason) return;
          const body: FinanceApprovalRequest = {
            action: 'WRITE_OFF',
            invoiceId: invoice.id,
            amount: amount.value,
            reason,
          };
          setSent(null);
          void request.run(async () => {
            setSent(await api.post<FinanceApprovalDto>(`${ctx.financePath}/approvals`, body));
            formElement.reset();
          });
        }}
      >
        {request.error ? <Alert>{errorMessage(request.error)}</Alert> : null}
        <TextField
          label={`Amount (${invoice.total.currency})`}
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={moneyInput(invoice.outstanding)}
          error={problems.amount}
        />
        <TextField label="Reason" name="reason" maxLength={500} error={problems.reason} />
        <Button type="submit" variant="secondary" busy={request.busy}>
          Ask for approval
        </Button>
      </form>
    </Card>
  );
}
