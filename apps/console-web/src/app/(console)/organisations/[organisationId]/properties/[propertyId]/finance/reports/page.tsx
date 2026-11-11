'use client';

import type {
  AccountingPeriodDto,
  AgeingDto,
  FinanceApprovalRequest,
  Paginated,
  StatementDto,
  UnitDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
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
  formatMoney,
  isNegative,
  isPositive,
  isZero,
  PARTY_LABELS,
  STATEMENT_KIND_LABELS,
} from '@/lib/finance';
import { errorMessage } from '@/lib/messages';
import { formatDate, todayIn } from '@/lib/residents';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';

export default function ReportsPage() {
  return (
    <FinanceFrame section="reports" title="Reports">
      {(ctx) => <Reports ctx={ctx} />}
    </FinanceFrame>
  );
}

interface Party {
  unitId: string;
  paidBy: 'OWNERS' | 'TENANTS';
  tenancyId: string | null;
}

function Reports({ ctx }: { ctx: FinanceContext }) {
  const [party, setParty] = useState<Party | null>(null);
  return (
    <>
      <Ageing ctx={ctx} onStatement={setParty} />
      <Statement ctx={ctx} party={party} onParty={setParty} />
      <Periods ctx={ctx} />
    </>
  );
}

const BUCKETS = [
  ['current', 'Not due'],
  ['days1to30', '1–30'],
  ['days31to60', '31–60'],
  ['days61to90', '61–90'],
  ['over90', '90+'],
] as const;

function Ageing({ ctx, onStatement }: { ctx: FinanceContext; onStatement(party: Party): void }) {
  const [asOf, setAsOf] = useState(() => todayIn(ctx.property.timeZone));
  const ageing = useApiQuery<AgeingDto>(`${ctx.financePath}/ageing?asOf=${asOf}`);
  return (
    <Card title="Ageing">
      <p className="muted">
        What each unit still owes, by days past the due date. It is built from what is owed now, so
        a past date only changes how late each invoice counts as.
      </p>
      <div className="form form--inline">
        <TextField
          label="Days late counted on"
          type="date"
          value={asOf}
          onChange={(event) => event.target.value && setAsOf(event.target.value)}
        />
      </div>
      {ageing.status === 'loading' ? <LoadingState label="Loading ageing" /> : null}
      {ageing.status === 'error' ? (
        <ErrorState error={ageing.error} onRetry={ageing.reload} />
      ) : null}
      {ageing.status === 'success' && ageing.data.rows.length === 0 ? (
        <p className="muted">Nothing is owed.</p>
      ) : null}
      {ageing.status === 'success' && ageing.data.rows.length > 0 ? (
        <TableWrap label="Ageing table">
          <table className="table">
            <caption className="visually-hidden">Ageing on {formatDate(ageing.data.asOf)}</caption>
            <thead>
              <tr>
                <th scope="col">Unit</th>
                {BUCKETS.map(([key, label]) => (
                  <th key={key} scope="col" className="num">
                    {label}
                  </th>
                ))}
                <th scope="col" className="num">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {ageing.data.rows.map((r) => (
                <tr key={`${r.unitId}-${r.billTo}-${r.tenancyId ?? ''}`}>
                  <th scope="row">
                    <button
                      type="button"
                      className="link-button"
                      aria-label={`Statement of unit ${r.unitNumber}, ${PARTY_LABELS[r.billTo].toLowerCase()}`}
                      onClick={() =>
                        onStatement({ unitId: r.unitId, paidBy: r.billTo, tenancyId: r.tenancyId })
                      }
                    >
                      {r.unitNumber}
                    </button>{' '}
                    <span className="muted">{PARTY_LABELS[r.billTo].toLowerCase()}</span>
                  </th>
                  {BUCKETS.map(([key]) => (
                    <td key={key} className="num">
                      {isZero(r.buckets[key]) ? '—' : formatMoney(r.buckets[key])}
                    </td>
                  ))}
                  <td className="num">{formatMoney(r.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                {BUCKETS.map(([key]) => (
                  <td key={key} className="num">
                    {formatMoney(ageing.data.totals[key])}
                  </td>
                ))}
                <td className="num">
                  {formatMoney(
                    ageing.data.rows.reduce(
                      (sum, r) => ({
                        amountMinor: (
                          BigInt(sum.amountMinor) + BigInt(r.total.amountMinor)
                        ).toString(),
                        currency: sum.currency,
                      }),
                      { amountMinor: '0', currency: ctx.property.currency },
                    ),
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </TableWrap>
      ) : null}
    </Card>
  );
}

function Statement({
  ctx,
  party,
  onParty,
}: {
  ctx: FinanceContext;
  party: Party | null;
  onParty(party: Party | null): void;
}) {
  const units = useApiQuery<Paginated<UnitDto>>(`${ctx.propertyPath}/units?limit=200`);
  const query = party
    ? `${ctx.financePath}/units/${party.unitId}/statement?paidBy=${party.paidBy}${
        party.tenancyId ? `&tenancyId=${party.tenancyId}` : ''
      }`
    : null;
  const statement = useApiQuery<StatementDto>(query);
  return (
    <Card title="Statement">
      <div className="form form--inline">
        <SelectField
          label="Unit"
          value={party?.unitId ?? ''}
          onChange={(event) =>
            onParty(
              event.target.value
                ? { unitId: event.target.value, paidBy: party?.paidBy ?? 'OWNERS', tenancyId: null }
                : null,
            )
          }
        >
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
          label="Party"
          value={party?.paidBy ?? 'OWNERS'}
          disabled={!party}
          onChange={(event) =>
            party &&
            onParty({
              unitId: party.unitId,
              paidBy: event.target.value === 'TENANTS' ? 'TENANTS' : 'OWNERS',
              tenancyId: null,
            })
          }
        >
          <option value="OWNERS">Owners</option>
          <option value="TENANTS">Current tenants</option>
        </SelectField>
      </div>
      {!party ? <p className="muted">Choose a unit, or a row in the ageing table.</p> : null}
      {party && statement.status === 'loading' ? (
        <LoadingState label="Loading the statement" />
      ) : null}
      {party && statement.status === 'error' ? (
        <ErrorState error={statement.error} onRetry={statement.reload} />
      ) : null}
      {party && statement.status === 'success' ? <StatementTable s={statement.data} /> : null}
    </Card>
  );
}

function StatementTable({ s }: { s: StatementDto }) {
  const closing = isPositive(s.balance)
    ? `${formatMoney(s.balance)} owed`
    : isNegative(s.balance)
      ? `${formatMoney({ ...s.balance, amountMinor: s.balance.amountMinor.slice(1) })} in credit`
      : 'Nothing owed';
  return (
    <>
      <p>
        <strong>
          Unit {s.unitNumber}, {PARTY_LABELS[s.paidBy].toLowerCase()}:
        </strong>{' '}
        {closing} on {formatDate(s.asOf)}.
      </p>
      {s.lines.length === 0 ? (
        <p className="muted">No invoices or payments yet.</p>
      ) : (
        <TableWrap label="Statement table">
          <table className="table">
            <caption className="visually-hidden">
              Statement of unit {s.unitNumber}, {PARTY_LABELS[s.paidBy].toLowerCase()}
            </caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Item</th>
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
              {s.lines.map((l, index) => (
                // Lines have no id; their order is fixed by the API.
                // biome-ignore lint/suspicious/noArrayIndexKey: stable order from the API.
                <tr key={index}>
                  <td>{formatDate(l.date)}</td>
                  <td>
                    {STATEMENT_KIND_LABELS[l.kind]} <span className="muted">{l.reference}</span>
                  </td>
                  <td className="num">{isZero(l.debit) ? '' : formatMoney(l.debit)}</td>
                  <td className="num">{isZero(l.credit) ? '' : formatMoney(l.credit)}</td>
                  <td className="num">{formatMoney(l.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </>
  );
}

function Periods({ ctx }: { ctx: FinanceContext }) {
  const periods = useApiQuery<{ data: AccountingPeriodDto[] }>(`${ctx.financePath}/periods`);
  const close = useAction();
  const reopen = useAction();
  const [reopening, setReopening] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const canManage = ctx.can('property.finance.manage');
  const rows = periods.status === 'success' ? [...periods.data.data].reverse() : [];
  return (
    <Card title="Accounting periods">
      <p className="muted">
        Nothing can be posted into a closed period. Reopening one needs a second person's approval.
      </p>
      {close.error ? <Alert>{errorMessage(close.error)}</Alert> : null}
      {sent ? (
        <Alert tone="success">
          Sent for approval. <Link href={`${ctx.financePath}/approvals`}>See the request</Link>
        </Alert>
      ) : null}
      {periods.status === 'loading' ? <LoadingState label="Loading periods" /> : null}
      {periods.status === 'error' ? (
        <ErrorState error={periods.error} onRetry={periods.reload} />
      ) : null}
      {periods.status === 'success' && rows.length === 0 ? (
        <p className="muted">No periods yet: the first opens when an invoice is issued.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Accounting periods">
          {rows.map((p) => {
            const label = `${formatDate(p.startDate)} to ${formatDate(p.endDate)}`;
            return (
              <li key={p.id} className="list__item">
                <div>
                  <p className="list__primary">
                    {label}{' '}
                    <Badge tone={p.status === 'OPEN' ? 'success' : 'muted'}>
                      {p.status.toLowerCase()}
                    </Badge>
                  </p>
                </div>
                {canManage && p.status === 'OPEN' ? (
                  <Button
                    variant="secondary"
                    busy={close.busy}
                    aria-label={`Close period ${label}`}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Close the period ${label}? Reopening it will need another person's approval.`,
                        )
                      )
                        return;
                      void close
                        .run(() => api.post(`${ctx.financePath}/periods/${p.id}/close`))
                        .then((ok) => ok && periods.reload());
                    }}
                  >
                    Close
                  </Button>
                ) : null}
                {canManage && p.status === 'CLOSED' && reopening !== p.id ? (
                  <Button
                    variant="secondary"
                    aria-label={`Reopen period ${label}`}
                    onClick={() => {
                      setSent(false);
                      setReopening(p.id);
                    }}
                  >
                    Reopen
                  </Button>
                ) : null}
                {reopening === p.id ? (
                  <form
                    className="form form--inline"
                    noValidate
                    aria-label={`Reopen period ${label}`}
                    onSubmit={(event: FormEvent<HTMLFormElement>) => {
                      event.preventDefault();
                      const reason = String(
                        new FormData(event.currentTarget).get('reason') ?? '',
                      ).trim();
                      if (!reason) return;
                      const body: FinanceApprovalRequest = {
                        action: 'REOPEN_PERIOD',
                        periodId: p.id,
                        reason,
                      };
                      void reopen
                        .run(() => api.post(`${ctx.financePath}/approvals`, body))
                        .then((ok) => {
                          if (!ok) return;
                          setReopening(null);
                          setSent(true);
                        });
                    }}
                  >
                    {reopen.error ? <Alert>{errorMessage(reopen.error)}</Alert> : null}
                    <TextField label="Reason" name="reason" maxLength={500} required />
                    <Button type="submit" busy={reopen.busy}>
                      Ask for approval
                    </Button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </Card>
  );
}
