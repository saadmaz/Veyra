'use client';

import type {
  AgeingDto,
  FinanceApprovalDto,
  FinanceSetupResponse,
  LedgerAccountDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { type FinanceContext, FinanceFrame } from '@/components/finance-frame';
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  ErrorState,
  LoadingState,
  TableWrap,
} from '@/components/ui';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/finance';
import { enumLabel, errorMessage } from '@/lib/messages';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';

/** A property's finance at a glance: set-up, what is owed, requests waiting for a decision. */
export default function FinanceOverviewPage() {
  return (
    <FinanceFrame section="overview" title="Finance">
      {(ctx) => <Overview ctx={ctx} />}
    </FinanceFrame>
  );
}

function Overview({ ctx }: { ctx: FinanceContext }) {
  const accounts = useApiQuery<{ data: LedgerAccountDto[] }>(`${ctx.financePath}/accounts`);
  if (accounts.status === 'loading') return <LoadingState label="Loading accounts" />;
  if (accounts.status === 'error')
    return <ErrorState error={accounts.error} onRetry={accounts.reload} />;
  if (accounts.data.data.length === 0) return <SetUp ctx={ctx} onDone={accounts.reload} />;
  return (
    <>
      <Owed ctx={ctx} />
      <Waiting ctx={ctx} />
      <Accounts accounts={accounts.data.data} />
    </>
  );
}

function SetUp({ ctx, onDone }: { ctx: FinanceContext; onDone(): void }) {
  const setUp = useAction();
  const canManage = ctx.can('property.finance.manage');
  return (
    <Card title="Set up finance">
      <p className="muted">
        Setting up creates this property's chart of accounts (bank, cash, receivables, unit credit,
        income and bad debts) and two charge types: service charges, billed to owners, and
        utilities, billed to the occupant. All amounts are in {ctx.property.currency}.
      </p>
      {setUp.error ? <Alert>{errorMessage(setUp.error)}</Alert> : null}
      {canManage ? (
        <div className="form__actions">
          <Button
            busy={setUp.busy}
            onClick={() =>
              void setUp
                .run(() => api.post<FinanceSetupResponse>(`${ctx.financePath}/setup`))
                .then((ok) => ok && onDone())
            }
          >
            Set up finance
          </Button>
        </div>
      ) : (
        <p>A finance officer needs to set up finance for this property.</p>
      )}
    </Card>
  );
}

const BUCKETS = [
  ['current', 'Not yet due'],
  ['days1to30', '1–30 days late'],
  ['days31to60', '31–60 days late'],
  ['days61to90', '61–90 days late'],
  ['over90', 'Over 90 days late'],
] as const;

function Owed({ ctx }: { ctx: FinanceContext }) {
  const ageing = useApiQuery<AgeingDto>(`${ctx.financePath}/ageing`);
  return (
    <Card
      title="Owed now"
      actions={
        <Link href={`${ctx.financePath}/reports`} className="list__link">
          Ageing by unit
        </Link>
      }
    >
      {ageing.status === 'loading' ? <LoadingState label="Loading what is owed" /> : null}
      {ageing.status === 'error' ? (
        <ErrorState error={ageing.error} onRetry={ageing.reload} />
      ) : null}
      {ageing.status === 'success' ? (
        ageing.data.rows.length === 0 ? (
          <p className="muted">Nothing is owed.</p>
        ) : (
          <dl className="details">
            {BUCKETS.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{formatMoney(ageing.data.totals[key])}</dd>
              </div>
            ))}
          </dl>
        )
      ) : null}
    </Card>
  );
}

function Waiting({ ctx }: { ctx: FinanceContext }) {
  const approvals = useApiQuery<{ data: FinanceApprovalDto[] }>(
    `${ctx.financePath}/approvals?status=PENDING`,
  );
  const rows = approvals.status === 'success' ? approvals.data.data : [];
  const forMe = rows.filter((a) => a.requestedBy.userId !== ctx.currentUserId);
  return (
    <Card title="Waiting for approval">
      {approvals.status === 'loading' ? <LoadingState label="Loading requests" /> : null}
      {approvals.status === 'error' ? (
        <ErrorState error={approvals.error} onRetry={approvals.reload} />
      ) : null}
      {approvals.status === 'success' ? (
        rows.length === 0 ? (
          <p className="muted">No requests are waiting.</p>
        ) : (
          <>
            <p>
              {rows.length === 1 ? '1 request is waiting' : `${rows.length} requests are waiting`}
              {ctx.can('property.finance.approve') && forMe.length > 0
                ? `, ${forMe.length} for you to decide.`
                : '.'}
            </p>
            <div className="form__actions">
              <ButtonLink href={`${ctx.financePath}/approvals`} variant="secondary">
                Review requests
              </ButtonLink>
            </div>
          </>
        )
      ) : null}
    </Card>
  );
}

function Accounts({ accounts }: { accounts: LedgerAccountDto[] }) {
  return (
    <Card title="Chart of accounts">
      <TableWrap label="Chart of accounts">
        <table className="table">
          <caption className="visually-hidden">Chart of accounts</caption>
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.code}</td>
                <td>
                  {a.name}
                  {a.status === 'ARCHIVED' ? <span className="muted"> (archived)</span> : null}
                </td>
                <td>{enumLabel(a.type)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}
