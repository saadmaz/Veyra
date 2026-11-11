import { ApiError } from '../../../platform/errors/api-error';
import { type IsoDate, planAllocations } from '../domain/finance-rules';
import type { FinanceUnitOfWork, LedgerAccountRecord, Party } from './finance-ports';

/** The active account with this system key, or a 409 telling staff to set finance up. */
export function systemAccount(
  accounts: readonly LedgerAccountRecord[],
  key: string,
): LedgerAccountRecord {
  const account = accounts.find((a) => a.systemKey === key && a.status === 'ACTIVE');
  if (!account) {
    throw new ApiError(
      409,
      'FINANCE_NOT_SET_UP',
      "Set up this property's finance (its default accounts) first",
    );
  }
  return account;
}

/** Opens the date's month if needed; a closed period refuses the posting. */
export async function requireOpenPeriod(uow: FinanceUnitOfWork, date: IsoDate): Promise<void> {
  if ((await uow.ensureMonthlyPeriod(date)) !== 'OPEN') {
    throw new ApiError(409, 'PERIOD_CLOSED', `The accounting period for ${date} is closed`);
  }
}

/**
 * Moves an amount between the unit's credit and its receivables: allocating debits unit credit
 * and credits receivables; releasing does the opposite.
 */
export async function postAllocationEntry(
  uow: FinanceUnitOfWork,
  input: { unitId: string; amountMinor: bigint; date: IsoDate; currency: string; release: boolean },
): Promise<string> {
  const accounts = await uow.accounts();
  const credit = systemAccount(accounts, 'UNIT_CREDIT').id;
  const receivables = systemAccount(accounts, 'RECEIVABLES').id;
  const [from, to] = input.release ? [receivables, credit] : [credit, receivables];
  await requireOpenPeriod(uow, input.date);
  return uow.postEntry(
    'ALLOCATION',
    input.release ? 'Payment allocation released' : 'Payment allocated to invoice',
    input.date,
    input.currency,
    [
      { accountId: from, unitId: input.unitId, debitMinor: input.amountMinor, creditMinor: 0n },
      { accountId: to, unitId: input.unitId, debitMinor: 0n, creditMinor: input.amountMinor },
    ],
  );
}

/**
 * Applies the party's unused payments to its unpaid invoices on the unit, oldest first (owner
 * decision, 2026-11-11). Runs after a payment arrives and after an invoice is issued, so credit
 * is never left idle while the same party owes money. Returns how much was applied.
 */
export async function applyCredit(
  uow: FinanceUnitOfWork,
  input: { unitId: string; party: Party; date: IsoDate; currency: string },
): Promise<bigint> {
  const [credits, invoices] = await Promise.all([
    uow.creditSources(input.unitId, input.party),
    uow.openInvoices(input.unitId, input.party),
  ]);
  let applied = 0n;
  for (const step of planAllocations(credits, invoices)) {
    const entryId = await postAllocationEntry(uow, {
      unitId: input.unitId,
      amountMinor: step.amountMinor,
      date: input.date,
      currency: input.currency,
      release: false,
    });
    await uow.createAllocation({
      unitId: input.unitId,
      paymentId: step.paymentId,
      invoiceId: step.invoiceId,
      amountMinor: step.amountMinor,
      journalEntryId: entryId,
    });
    applied += step.amountMinor;
  }
  return applied;
}
