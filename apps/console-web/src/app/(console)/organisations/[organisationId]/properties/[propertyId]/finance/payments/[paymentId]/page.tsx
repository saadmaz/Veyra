'use client';

import type {
  AllocatePaymentRequest,
  FinanceApprovalDto,
  FinanceApprovalRequest,
  InvoiceDto,
  PaymentDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, type ReactNode, useState } from 'react';
import { type FinanceContext, FinanceFrame } from '@/components/finance-frame';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
} from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import {
  APPROVAL_ACTION_LABELS,
  formatMoney,
  isPositive,
  MANUAL_PAYMENT_METHODS,
  minMoney,
  moneyInput,
  PARTY_LABELS,
  PAYMENT_METHOD_LABELS,
  parseAmount,
} from '@/lib/finance';
import { errorMessage } from '@/lib/messages';
import { formatDate } from '@/lib/residents';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';

export default function PaymentPage() {
  return (
    <FinanceFrame
      section="payments"
      title="Receipt"
      crumb={{ label: 'Payments', path: '/payments' }}
    >
      {(ctx) => <Payment ctx={ctx} />}
    </FinanceFrame>
  );
}

function Payment({ ctx }: { ctx: FinanceContext }) {
  const { paymentId } = useParams<{ paymentId: string }>();
  const payment = useApiQuery<PaymentDto>(`${ctx.financePath}/payments/${paymentId}`);
  const approvals = useApiQuery<{ data: FinanceApprovalDto[] }>(
    `${ctx.financePath}/approvals?status=PENDING`,
  );
  const release = useAction();
  if (payment.status === 'loading') return <LoadingState label="Loading the receipt" />;
  if (payment.status === 'error') {
    if (payment.error instanceof ApiRequestError && payment.error.status === 404) {
      return <EmptyState title="Receipt not found" />;
    }
    return <ErrorState error={payment.error} onRetry={payment.reload} />;
  }
  const p = payment.data;
  const canManage = ctx.can('property.finance.manage');
  const live = !p.reversedOn;
  const pending =
    approvals.status === 'success' ? approvals.data.data.filter((a) => a.paymentId === p.id) : [];
  const reload = () => {
    payment.reload();
    approvals.reload();
  };
  return (
    <>
      <Card
        title={`Receipt ${p.receiptNumber}`}
        actions={p.reversedOn ? <Badge tone="danger">reversed</Badge> : null}
      >
        <dl className="details">
          <div>
            <dt>Unit</dt>
            <dd>{p.unitNumber}</dd>
          </div>
          <div>
            <dt>Paid by</dt>
            <dd>{PARTY_LABELS[p.paidBy]}</dd>
          </div>
          <div>
            <dt>Method</dt>
            <dd>{PAYMENT_METHOD_LABELS[p.method]}</dd>
          </div>
          <div>
            <dt>Received</dt>
            <dd>{formatDate(p.receivedOn)}</dd>
          </div>
          {p.reference ? (
            <div>
              <dt>Reference</dt>
              <dd>{p.reference}</dd>
            </div>
          ) : null}
          <div>
            <dt>Amount</dt>
            <dd>{formatMoney(p.amount)}</dd>
          </div>
          <div>
            <dt>Applied to invoices</dt>
            <dd>{formatMoney(p.allocated)}</dd>
          </div>
          <div>
            <dt>Unused (credit)</dt>
            <dd>{formatMoney(p.unallocated)}</dd>
          </div>
          {isPositive(p.refunded) ? (
            <div>
              <dt>Refunded</dt>
              <dd>{formatMoney(p.refunded)}</dd>
            </div>
          ) : null}
          {p.reversedOn ? (
            <div>
              <dt>Reversed on</dt>
              <dd>{formatDate(p.reversedOn)}</dd>
            </div>
          ) : null}
        </dl>
      </Card>

      {pending.length > 0 ? (
        <Alert tone="info" title="Waiting for approval">
          {pending.map((a) => APPROVAL_ACTION_LABELS[a.action]).join(', ')} requested.{' '}
          <Link href={`${ctx.financePath}/approvals`}>See the requests</Link>
        </Alert>
      ) : null}

      <Card title="Applied to">
        {release.error ? <Alert>{errorMessage(release.error)}</Alert> : null}
        {p.allocations.length === 0 ? (
          <p className="muted">Not applied to any invoice.</p>
        ) : (
          <ul className="list" aria-label="Allocations">
            {p.allocations.map((a) => (
              <li key={a.id} className="list__item">
                <div>
                  <p className="list__primary">
                    <Link href={`${ctx.financePath}/invoices/${a.invoiceId}`}>
                      {a.invoiceNumber ?? 'Invoice'}
                    </Link>{' '}
                    <span className="muted">{formatMoney(a.amount)}</span>
                  </p>
                  {a.releasedAt ? <p className="list__meta">Taken back</p> : null}
                </div>
                {canManage && live && !a.releasedAt ? (
                  <Button
                    variant="secondary"
                    busy={release.busy}
                    aria-label={`Take back from ${a.invoiceNumber ?? 'invoice'}`}
                    onClick={() => {
                      if (
                        !window.confirm(
                          'Take this money back from the invoice? It returns to the unused part of the payment.',
                        )
                      )
                        return;
                      void release
                        .run(() => api.post(`${ctx.financePath}/allocations/${a.id}/release`))
                        .then((ok) => ok && reload());
                    }}
                  >
                    Take back
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage && live && isPositive(p.unallocated) ? (
        <>
          <Allocate ctx={ctx} payment={p} onDone={reload} />
          <Refund ctx={ctx} payment={p} onDone={reload} />
        </>
      ) : null}
      {canManage && live && !isPositive(p.refunded) ? (
        <Reverse ctx={ctx} payment={p} onDone={reload} />
      ) : null}
    </>
  );
}

function Allocate({
  ctx,
  payment,
  onDone,
}: {
  ctx: FinanceContext;
  payment: PaymentDto;
  onDone(): void;
}) {
  const invoices = useApiQuery<{ data: InvoiceDto[] }>(
    `${ctx.financePath}/invoices?status=ISSUED&unitId=${payment.unitId}`,
  );
  const allocate = useAction();
  const [problem, setProblem] = useState<string | null>(null);
  const open =
    invoices.status === 'success'
      ? invoices.data.data.filter((i) => i.billTo === payment.paidBy && isPositive(i.outstanding))
      : [];
  const [invoiceId, setInvoiceId] = useState('');
  const chosen = open.find((i) => i.id === invoiceId);
  return (
    <Card title="Apply to an invoice">
      {invoices.status === 'loading' ? <LoadingState label="Loading invoices" /> : null}
      {invoices.status === 'error' ? (
        <ErrorState error={invoices.error} onRetry={invoices.reload} />
      ) : null}
      {invoices.status === 'success' && open.length === 0 ? (
        <p className="muted">
          This unit's {PARTY_LABELS[payment.paidBy].toLowerCase()} have no unpaid invoices. The
          unused money is applied to their next invoice automatically.
        </p>
      ) : null}
      {open.length > 0 ? (
        <form
          className="form form--inline"
          noValidate
          aria-label="Apply to an invoice"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const amount = parseAmount(String(form.get('amount') ?? ''), payment.amount.currency);
            if (!invoiceId) return setProblem('Choose an invoice.');
            if (!amount.ok) return setProblem(amount.error);
            setProblem(null);
            const body: AllocatePaymentRequest = { invoiceId, amount: amount.value };
            void allocate
              .run(() => api.post(`${ctx.financePath}/payments/${payment.id}/allocations`, body))
              .then((ok) => {
                if (!ok) return;
                setInvoiceId('');
                invoices.reload();
                onDone();
              });
          }}
        >
          {problem ? <Alert>{problem}</Alert> : null}
          {allocate.error ? <Alert>{errorMessage(allocate.error)}</Alert> : null}
          <SelectField
            label="Invoice"
            value={invoiceId}
            onChange={(event) => setInvoiceId(event.target.value)}
          >
            <option value="">Choose an invoice</option>
            {open.map((i) => (
              <option key={i.id} value={i.id}>
                {i.number} · owes {formatMoney(i.outstanding)}
              </option>
            ))}
          </SelectField>
          <TextField
            key={invoiceId}
            label={`Amount (${payment.amount.currency})`}
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={moneyInput(
              chosen ? minMoney(chosen.outstanding, payment.unallocated) : payment.unallocated,
            )}
          />
          <Button type="submit" busy={allocate.busy}>
            Apply
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

/** Shared form for the two risky payment actions, which need a second person's approval. */
function ApprovalForm({
  ctx,
  title,
  explanation,
  label,
  build,
  children,
  onDone,
}: {
  ctx: FinanceContext;
  title: string;
  explanation: string;
  label: string;
  build(form: FormData, reason: string): FinanceApprovalRequest | string;
  children?: ReactNode;
  onDone(): void;
}) {
  const request = useAction();
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  return (
    <Card title={title}>
      <p className="muted">{explanation}</p>
      {sent ? <Alert tone="success">Sent for approval.</Alert> : null}
      <form
        className="form form--inline"
        noValidate
        aria-label={title}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const formElement = event.currentTarget;
          const form = new FormData(formElement);
          const reason = String(form.get('reason') ?? '').trim();
          if (!reason) return setProblem('Say why.');
          const body = build(form, reason);
          if (typeof body === 'string') return setProblem(body);
          setProblem(null);
          setSent(false);
          void request
            .run(() => api.post<FinanceApprovalDto>(`${ctx.financePath}/approvals`, body))
            .then((ok) => {
              if (!ok) return;
              setSent(true);
              formElement.reset();
              onDone();
            });
        }}
      >
        {problem ? <Alert>{problem}</Alert> : null}
        {request.error ? <Alert>{errorMessage(request.error)}</Alert> : null}
        {children}
        <TextField label="Reason" name="reason" maxLength={500} />
        <Button type="submit" variant="secondary" busy={request.busy}>
          {label}
        </Button>
      </form>
    </Card>
  );
}

function Refund({
  ctx,
  payment,
  onDone,
}: {
  ctx: FinanceContext;
  payment: PaymentDto;
  onDone(): void;
}) {
  return (
    <ApprovalForm
      ctx={ctx}
      title="Refund"
      explanation="Pays back money from this payment that is not applied to any invoice. Another finance officer or admin must approve it."
      label="Ask for approval"
      onDone={onDone}
      build={(form, reason) => {
        const amount = parseAmount(String(form.get('amount') ?? ''), payment.amount.currency);
        if (!amount.ok) return amount.error;
        return {
          action: 'REFUND',
          paymentId: payment.id,
          amount: amount.value,
          method: String(form.get('method')) as 'BANK_TRANSFER' | 'CASH' | 'CHEQUE',
          reason,
        };
      }}
    >
      <TextField
        label={`Amount (${payment.amount.currency})`}
        name="amount"
        inputMode="decimal"
        autoComplete="off"
        defaultValue={moneyInput(payment.unallocated)}
      />
      <SelectField label="Paid back by" name="method" defaultValue="BANK_TRANSFER">
        {MANUAL_PAYMENT_METHODS.map((m) => (
          <option key={m} value={m}>
            {PAYMENT_METHOD_LABELS[m]}
          </option>
        ))}
      </SelectField>
    </ApprovalForm>
  );
}

function Reverse({
  ctx,
  payment,
  onDone,
}: {
  ctx: FinanceContext;
  payment: PaymentDto;
  onDone(): void;
}) {
  return (
    <ApprovalForm
      ctx={ctx}
      title="Reverse this payment"
      explanation="For money that never arrived, such as a bounced cheque. It is taken back from every invoice and its ledger entry is reversed. Another finance officer or admin must approve it."
      label="Ask for approval"
      onDone={onDone}
      build={(_form, reason) => ({ action: 'REVERSE_PAYMENT', paymentId: payment.id, reason })}
    />
  );
}
