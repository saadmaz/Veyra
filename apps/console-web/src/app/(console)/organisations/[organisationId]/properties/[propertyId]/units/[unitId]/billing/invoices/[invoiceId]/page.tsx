'use client';

import type { MyInvoiceDetailDto } from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { Badge, Card, EmptyState, ErrorState, LoadingState, TableWrap } from '@/components/ui';
import { ApiRequestError } from '@/lib/api-client';
import {
  ACCOUNT_LABELS,
  formatMoney,
  formatMonth,
  INVOICE_STATE_TONES,
  invoiceState,
  isPositive,
} from '@/lib/finance';
import { formatDate } from '@/lib/residents';
import { useApiQuery } from '@/lib/use-api';

/** One of the resident's own invoices: its lines, credit notes and what is still to pay. */
export default function MyInvoicePage() {
  const { organisationId, propertyId, unitId, invoiceId } = useParams<{
    organisationId: string;
    propertyId: string;
    unitId: string;
    invoiceId: string;
  }>();
  const unitPath = `/organisations/${organisationId}/properties/${propertyId}/units/${unitId}`;
  const invoice = useApiQuery<MyInvoiceDetailDto>(`${unitPath}/my-finance/invoices/${invoiceId}`);

  useEffect(() => {
    if (invoice.status === 'success' && invoice.data.number) {
      document.title = `Invoice ${invoice.data.number} · VEYRA Console`;
    }
  }, [invoice]);

  const crumbs = (unitNumber?: string) => (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link href={unitPath}>{unitNumber ? `Unit ${unitNumber}` : 'Unit'}</Link>
      {' / '}
      <Link href={`${unitPath}/billing`}>Billing</Link>
    </nav>
  );

  if (invoice.status === 'loading') return <LoadingState label="Loading invoice" />;
  if (invoice.status === 'error') {
    if (invoice.error instanceof ApiRequestError && invoice.error.status === 404) {
      return (
        <>
          {crumbs()}
          <EmptyState title="Invoice not found">
            It does not exist, or it is addressed to someone else.
          </EmptyState>
        </>
      );
    }
    return <ErrorState error={invoice.error} onRetry={invoice.reload} />;
  }
  const i = invoice.data;
  const state = invoiceState(i);
  return (
    <>
      {crumbs(i.unitNumber)}
      <div className="page__header">
        <h1>Invoice {i.number}</h1>
        <Badge tone={INVOICE_STATE_TONES[state]}>{state}</Badge>
      </div>
      <Card title="Summary">
        <dl className="details">
          <div>
            <dt>Account</dt>
            <dd>{ACCOUNT_LABELS[i.billTo]}</dd>
          </div>
          <div>
            <dt>Addressed to</dt>
            <dd>{i.recipients.map((r) => r.fullName).join(', ') || '—'}</dd>
          </div>
          {i.billingMonth ? (
            <div>
              <dt>For</dt>
              <dd>{formatMonth(i.billingMonth)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Issued</dt>
            <dd>{i.issueDate ? formatDate(i.issueDate) : '—'}</dd>
          </div>
          <div>
            <dt>Due</dt>
            <dd>{formatDate(i.dueDate)}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd>{formatMoney(i.total)}</dd>
          </div>
          <div>
            <dt>Paid</dt>
            <dd>{formatMoney(i.paid)}</dd>
          </div>
          {isPositive(i.credited) ? (
            <div>
              <dt>Credited</dt>
              <dd>{formatMoney(i.credited)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Still to pay</dt>
            <dd>{formatMoney(i.outstanding)}</dd>
          </div>
        </dl>
      </Card>
      <Card title="Charges">
        <TableWrap label="Charges">
          <table className="table">
            <caption className="visually-hidden">Charges</caption>
            <thead>
              <tr>
                <th scope="col">Description</th>
                <th scope="col" className="num">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {i.lines.map((l) => (
                <tr key={l.lineNumber}>
                  <td>{l.description}</td>
                  <td className="num">{formatMoney(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
      {i.credits.length > 0 ? (
        <Card title="Credits">
          <ul className="list" aria-label="Credits">
            {i.credits.map((c) => (
              <li key={c.id} className="list__item">
                <div>
                  <p className="list__primary">
                    {c.number ?? 'Write-off'} · {formatMoney(c.amount)}
                  </p>
                  <p className="list__meta">
                    {formatDate(c.creditedOn)} · {c.reason}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
