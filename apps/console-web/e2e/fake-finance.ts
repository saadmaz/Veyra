import { randomUUID } from 'node:crypto';
import type {
  AccountingPeriodDto,
  AgeingDto,
  BankTransferDto,
  ChargeTypeDto,
  FinanceApprovalDto,
  InvoiceCreditDto,
  InvoiceDetailDto,
  InvoiceDto,
  LedgerAccountDto,
  MoneyDto,
  OwnershipDto,
  PaymentDto,
  RecurringChargeDto,
  StatementDto,
  StatementLineDto,
  TenancyDto,
  UnitDto,
} from '@veyra/api-contracts';

/**
 * In-memory finance endpoints for the browser journeys (see fake-api.ts). It follows the wire
 * contracts and the main rules of the real API: oldest-first allocation, idempotent payments,
 * maker-checker approvals that never let the requester decide, closed periods, credit limits.
 * The real rules are proven by the API's integration tests; this only has to be faithful
 * enough for the console's journeys. Amounts are bigint minor units; the currency has 2 decimals.
 */

type Party = 'OWNERS' | 'TENANTS';

export interface FinanceRequest {
  method: string;
  /** Path below /properties/:id, starting with /finance. */
  sub: string;
  body: Record<string, unknown>;
  url: URL;
  idempotencyKey: string | undefined;
  property: { id: string; currency: string; timeZone: string };
  permissions: string[];
  user: { id: string; displayName: string };
  units: UnitDto[];
  ownerships: OwnershipDto[];
  tenancies: TenancyDto[];
  today: string;
}

export interface FinanceReply {
  status: number;
  body?: unknown;
}

interface Invoice {
  id: string;
  propertyId: string;
  number: string | null;
  status: 'DRAFT' | 'ISSUED';
  unitId: string;
  billTo: Party;
  tenancyId: string | null;
  recipients: InvoiceDto['recipients'];
  billingMonth: string | null;
  billingDate: string;
  dueDate: string;
  issueDate: string | null;
  lines: {
    lineNumber: number;
    chargeTypeId: string;
    description: string;
    amount: bigint;
    billingMonth: string | null;
    runKey: string | null;
  }[];
  credits: (Omit<InvoiceCreditDto, 'amount'> & { amount: bigint })[];
  createdAt: string;
  issuedAt: string | null;
}

interface Payment {
  id: string;
  propertyId: string;
  receiptNumber: string;
  unitId: string;
  paidBy: Party;
  method: PaymentDto['method'];
  amount: bigint;
  refunded: { amount: bigint; on: string }[];
  reversedOn: string | null;
  receivedOn: string;
  reference: string | null;
  idempotencyKey: string | null;
  requestHash: string;
  createdAt: string;
}

interface Allocation {
  id: string;
  paymentId: string;
  invoiceId: string;
  amount: bigint;
  createdAt: string;
  releasedAt: string | null;
}

type Approval = Omit<FinanceApprovalDto, 'amount'> & { propertyId: string; amount: bigint | null };

interface Transfer {
  id: string;
  propertyId: string;
  unitId: string;
  paidBy: Party;
  amount: bigint;
  transferredOn: string;
  reference: string;
  note: string | null;
  status: BankTransferDto['status'];
  submittedBy: { userId: string; name: string };
  idempotencyKey: string;
  requestHash: string;
  decidedAt: string | null;
  rejectionReason: string | null;
  paymentId: string | null;
  createdAt: string;
}

/** A resident's request below …/units/:unitId/my-finance (Phase 6 Part 6). */
export interface ResidentFinanceRequest extends Omit<FinanceRequest, 'sub' | 'permissions'> {
  /** Path below /my-finance, e.g. "" or "/invoices". */
  sub: string;
  unit: UnitDto;
  /** The caller's derived roles on the unit today. */
  roles: string[];
}

const now = () => new Date().toISOString();
const DAY = 86_400_000;

function parseMinor(text: unknown): bigint | null {
  if (typeof text !== 'string') return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const value = BigInt(match[1] ?? '0') * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  return value > 0n ? value : null;
}

const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const covers = (from: string, to: string | null, day: string) => from <= day && (!to || day <= to);
const monthEnd = (month: string) => {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
};
const number = (prefix: string, n: number) => `${prefix}-${String(n).padStart(6, '0')}`;

const ok = (body?: unknown, status = 200): FinanceReply => ({ status, body });
const fail = (status: number, code: string, message = code): FinanceReply => ({
  status,
  body: { error: { code, message, requestId: 'e2e' } },
});

export class FakeFinance {
  accounts: (LedgerAccountDto & { propertyId: string })[] = [];
  chargeTypes: (ChargeTypeDto & { propertyId: string })[] = [];
  recurring: (Omit<RecurringChargeDto, 'amount' | 'unitNumber' | 'chargeTypeCode'> & {
    propertyId: string;
    amount: bigint;
  })[] = [];
  invoices: Invoice[] = [];
  payments: Payment[] = [];
  allocations: Allocation[] = [];
  approvals: Approval[] = [];
  periods: (AccountingPeriodDto & { propertyId: string })[] = [];
  transfers: Transfer[] = [];
  private counters = new Map<string, number>();

  private next(propertyId: string, prefix: string): string {
    const key = `${propertyId}:${prefix}`;
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return number(prefix, n);
  }

  // ------------------------------------------------------------------ seeding helpers

  /** Sets up finance for a property, as POST …/finance/setup does. */
  setUp(propertyId: string): void {
    if (this.accounts.some((a) => a.propertyId === propertyId)) return;
    const add = (code: string, name: string, type: LedgerAccountDto['type'], systemKey: string) => {
      const account = {
        id: randomUUID(),
        propertyId,
        code,
        name,
        type,
        systemKey,
        status: 'ACTIVE' as const,
      };
      this.accounts.push(account);
      return account;
    };
    add('1000', 'Bank', 'ASSET', 'BANK');
    add('1010', 'Cash', 'ASSET', 'CASH');
    add('1100', 'Receivables from units', 'ASSET', 'RECEIVABLES');
    add('2100', 'Unit credit (overpayments)', 'LIABILITY', 'UNIT_CREDIT');
    const service = add('4000', 'Service charge income', 'INCOME', 'SERVICE_CHARGE_INCOME');
    const utility = add('4100', 'Utility income', 'INCOME', 'UTILITY_INCOME');
    add('4900', 'Other income', 'INCOME', 'OTHER_INCOME');
    add('5100', 'Bad debts written off', 'EXPENSE', 'BAD_DEBT');
    this.chargeTypes.push(
      {
        id: randomUUID(),
        propertyId,
        code: 'SERVICE',
        name: 'Service charge',
        liableParty: 'OWNERS',
        incomeAccountId: service.id,
        status: 'ACTIVE',
      },
      {
        id: randomUUID(),
        propertyId,
        code: 'UTILITIES',
        name: 'Utilities',
        liableParty: 'OCCUPANT',
        incomeAccountId: utility.id,
        status: 'ACTIVE',
      },
    );
  }

  /** An issued invoice for a unit's owners, with one SERVICE line. */
  seedIssuedInvoice(
    ctx: Pick<FinanceRequest, 'units' | 'ownerships' | 'tenancies'> & { propertyId: string },
    unitId: string,
    amountMinor: bigint,
    issueDate: string,
    dueDate: string,
  ): Invoice {
    const service = this.chargeTypes.find(
      (c) => c.propertyId === ctx.propertyId && c.code === 'SERVICE',
    );
    if (!service) throw new Error('set up finance first');
    const invoice = this.draft(
      ctx.propertyId,
      unitId,
      'OWNERS',
      null,
      this.ownerRecipients(ctx.ownerships, unitId, issueDate),
      issueDate,
      dueDate,
      null,
    );
    invoice.lines.push({
      lineNumber: 1,
      chargeTypeId: service.id,
      description: 'Service charge',
      amount: amountMinor,
      billingMonth: null,
      runKey: null,
    });
    this.issue(ctx.propertyId, invoice, issueDate);
    return invoice;
  }

  // ------------------------------------------------------------------ dto mapping

  private money(amount: bigint, currency = 'PKR'): MoneyDto {
    return { amountMinor: amount.toString(), currency };
  }

  private paidOn(invoiceId: string): bigint {
    return sum(
      this.allocations
        .filter((a) => a.invoiceId === invoiceId && !a.releasedAt)
        .map((a) => a.amount),
    );
  }

  private invoiceTotals(i: Invoice, today: string) {
    const total = sum(i.lines.map((l) => l.amount));
    const paid = this.paidOn(i.id);
    const credited = sum(i.credits.map((c) => c.amount));
    const outstanding = i.status === 'ISSUED' ? total - paid - credited : total;
    return {
      total,
      paid,
      credited,
      outstanding,
      overdue: i.status === 'ISSUED' && outstanding > 0n && i.dueDate < today,
    };
  }

  private invoiceDto(i: Invoice, units: UnitDto[], today: string): InvoiceDto {
    const t = this.invoiceTotals(i, today);
    return {
      id: i.id,
      number: i.number,
      status: i.status,
      unitId: i.unitId,
      unitNumber: units.find((u) => u.id === i.unitId)?.number ?? '?',
      billTo: i.billTo,
      recipients: i.recipients,
      billingMonth: i.billingMonth,
      billingDate: i.billingDate,
      dueDate: i.dueDate,
      issueDate: i.issueDate,
      total: this.money(t.total),
      paid: this.money(t.paid),
      credited: this.money(t.credited),
      outstanding: this.money(t.outstanding),
      overdue: t.overdue,
      createdAt: i.createdAt,
      issuedAt: i.issuedAt,
    };
  }

  private invoiceDetail(i: Invoice, units: UnitDto[], today: string): InvoiceDetailDto {
    const codes = (id: string) => this.chargeTypes.find((c) => c.id === id)?.code ?? '?';
    return {
      ...this.invoiceDto(i, units, today),
      lines: i.lines.map((l) => ({
        lineNumber: l.lineNumber,
        chargeTypeId: l.chargeTypeId,
        chargeTypeCode: codes(l.chargeTypeId),
        description: l.description,
        amount: this.money(l.amount),
        billingMonth: l.billingMonth,
      })),
      credits: i.credits.map((c) => ({ ...c, amount: this.money(c.amount) })),
      journalEntryId: i.status === 'ISSUED' ? `je-${i.id}` : null,
    };
  }

  private paymentDto(p: Payment, units: UnitDto[]): PaymentDto {
    const allocations = this.allocations.filter((a) => a.paymentId === p.id);
    const allocated = sum(allocations.filter((a) => !a.releasedAt).map((a) => a.amount));
    const refunded = sum(p.refunded.map((r) => r.amount));
    return {
      id: p.id,
      receiptNumber: p.receiptNumber,
      unitId: p.unitId,
      unitNumber: units.find((u) => u.id === p.unitId)?.number ?? '?',
      paidBy: p.paidBy,
      method: p.method,
      amount: this.money(p.amount),
      allocated: this.money(allocated),
      unallocated: this.money(p.reversedOn ? 0n : p.amount - allocated - refunded),
      refunded: this.money(refunded),
      reversedOn: p.reversedOn,
      receivedOn: p.receivedOn,
      reference: p.reference,
      allocations: allocations.map((a) => ({
        id: a.id,
        invoiceId: a.invoiceId,
        invoiceNumber: this.invoices.find((i) => i.id === a.invoiceId)?.number ?? null,
        amount: this.money(a.amount),
        createdAt: a.createdAt,
        releasedAt: a.releasedAt,
      })),
      createdAt: p.createdAt,
    };
  }

  private transferDto(t: Transfer, units: UnitDto[]): BankTransferDto {
    return {
      id: t.id,
      unitId: t.unitId,
      unitNumber: units.find((u) => u.id === t.unitId)?.number ?? '?',
      paidBy: t.paidBy,
      amount: this.money(t.amount),
      transferredOn: t.transferredOn,
      reference: t.reference,
      note: t.note,
      status: t.status,
      submittedBy: { name: t.submittedBy.name },
      decidedAt: t.decidedAt,
      rejectionReason: t.rejectionReason,
      paymentId: t.paymentId,
      receiptNumber: this.payments.find((p) => p.id === t.paymentId)?.receiptNumber ?? null,
      createdAt: t.createdAt,
    };
  }

  /**
   * A resident's own account(s) of a unit, as the real API narrows them: owners see the owners'
   * account, tenants their tenancy's; drafts and other accounts do not exist for them.
   */
  handleResident(req: ResidentFinanceRequest): FinanceReply {
    const { method, sub, body, url, property, today, unit } = req;
    const pid = property.id;
    const parties: Party[] = [];
    if (req.roles.includes('OWNER')) parties.push('OWNERS');
    if (req.roles.includes('TENANT')) parties.push('TENANTS');
    if (parties.length === 0) return fail(403, 'FORBIDDEN');
    const chosen = (paidBy: string | null): Party[] | null => {
      if (!paidBy) return parties;
      return parties.includes(paidBy as Party) ? [paidBy as Party] : null;
    };
    const visibleInvoices = (ps: Party[]) =>
      this.invoices
        .filter(
          (i) =>
            i.propertyId === pid &&
            i.unitId === unit.id &&
            i.status === 'ISSUED' &&
            ps.includes(i.billTo),
        )
        .reverse();
    const visiblePayments = (ps: Party[]) =>
      this.payments
        .filter((p) => p.propertyId === pid && p.unitId === unit.id && ps.includes(p.paidBy))
        .reverse();
    const transfers = (ps: Party[]) =>
      this.transfers
        .filter((t) => t.propertyId === pid && t.unitId === unit.id && ps.includes(t.paidBy))
        .reverse();
    const units = [unit];

    if (sub === '' && method === 'GET') {
      return ok({
        unitId: unit.id,
        unitNumber: unit.number,
        asOf: today,
        currency: property.currency,
        accounts: parties.map((paidBy) => {
          const overdue = visibleInvoices([paidBy])
            .map((i) => this.invoiceDto(i, units, today))
            .filter((i) => i.overdue)
            .map((i) => BigInt(i.outstanding.amountMinor));
          return {
            paidBy,
            tenancyId:
              paidBy === 'TENANTS'
                ? (req.tenancies.find(
                    (t) =>
                      t.unitId === unit.id && !t.voidedAt && covers(t.startDate, t.endDate, today),
                  )?.id ?? null)
                : null,
            balance: this.statement(pid, unit, paidBy, today).balance,
            overdue: this.money(sum(overdue)),
            pendingTransfers: this.money(
              sum(
                transfers([paidBy])
                  .filter((t) => t.status === 'PENDING')
                  .map((t) => t.amount),
              ),
            ),
          };
        }),
      });
    }
    if (sub === '/invoices' && method === 'GET') {
      const ps = chosen(url.searchParams.get('paidBy'));
      if (!ps) return fail(404, 'NOT_FOUND');
      return ok({ data: visibleInvoices(ps).map((i) => this.invoiceDto(i, units, today)) });
    }
    const invoiceMatch = /^\/invoices\/([^/]+)$/.exec(sub);
    if (invoiceMatch && method === 'GET') {
      const invoice = visibleInvoices(parties).find((i) => i.id === invoiceMatch[1]);
      if (!invoice) return fail(404, 'NOT_FOUND');
      const { journalEntryId: _ledger, ...detail } = this.invoiceDetail(invoice, units, today);
      return ok(detail);
    }
    if (sub === '/payments' && method === 'GET') {
      const ps = chosen(url.searchParams.get('paidBy'));
      if (!ps) return fail(404, 'NOT_FOUND');
      return ok({ data: visiblePayments(ps).map((p) => this.paymentDto(p, units)) });
    }
    if (sub === '/statement' && method === 'GET') {
      const ps = chosen(url.searchParams.get('paidBy'));
      if (!ps || !url.searchParams.get('paidBy')) return fail(404, 'NOT_FOUND');
      return ok(this.statement(pid, unit, ps[0] as Party, today));
    }
    if (sub === '/bank-transfers') {
      if (method === 'GET')
        return ok({ data: transfers(parties).map((t) => this.transferDto(t, units)) });
      const key = req.idempotencyKey;
      if (!key || !/^[0-9a-f-]{36}$/i.test(key)) return fail(400, 'IDEMPOTENCY_KEY_REQUIRED');
      const requestHash = JSON.stringify(body);
      const earlier = this.transfers.find((t) => t.idempotencyKey === key);
      if (earlier) {
        return earlier.requestHash === requestHash
          ? ok(this.transferDto(earlier, units))
          : fail(409, 'IDEMPOTENCY_KEY_REUSED');
      }
      const ps = chosen(typeof body.paidBy === 'string' ? body.paidBy : null);
      if (!ps || !body.paidBy) return fail(404, 'NOT_FOUND');
      const amount = parseMinor(body.amount);
      const transferredOn = typeof body.transferredOn === 'string' ? body.transferredOn : '';
      const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
      if (!amount || !/^\d{4}-\d{2}-\d{2}$/.test(transferredOn) || !reference)
        return fail(400, 'VALIDATION_FAILED');
      if (transferredOn > today)
        return fail(422, 'VALIDATION_FAILED', 'A transfer cannot be dated in the future');
      if (transfers(ps).filter((t) => t.status === 'PENDING').length >= 10)
        return fail(409, 'TOO_MANY_PENDING');
      const transfer: Transfer = {
        id: randomUUID(),
        propertyId: pid,
        unitId: unit.id,
        paidBy: ps[0] as Party,
        amount,
        transferredOn,
        reference,
        note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
        status: 'PENDING',
        submittedBy: { userId: req.user.id, name: req.user.displayName },
        idempotencyKey: key,
        requestHash,
        decidedAt: null,
        rejectionReason: null,
        paymentId: null,
        createdAt: now(),
      };
      this.transfers.push(transfer);
      return ok(this.transferDto(transfer, units), 201);
    }
    return fail(404, 'NOT_FOUND');
  }

  private approvalDto(a: Approval): FinanceApprovalDto {
    const { propertyId: _p, amount, ...rest } = a;
    return { ...rest, amount: amount === null ? null : this.money(amount) };
  }

  // ------------------------------------------------------------------ rules

  private ownerRecipients(ownerships: OwnershipDto[], unitId: string, day: string) {
    return ownerships
      .filter(
        (o) => o.unitId === unitId && !o.voidedAt && covers(o.effectiveFrom, o.effectiveTo, day),
      )
      .map((o) => ({
        personId: o.personId,
        fullName: o.fullName,
        share: { numerator: o.shareNumerator, denominator: o.shareDenominator },
      }));
  }

  /** Who pays a charge type on a day: owners, or for OCCUPANT the current tenancy. */
  private billParty(
    req: Pick<FinanceRequest, 'ownerships' | 'tenancies'>,
    unitId: string,
    liable: 'OWNERS' | 'OCCUPANT',
    day: string,
  ) {
    if (liable === 'OCCUPANT') {
      const tenancy = req.tenancies.find(
        (t) => t.unitId === unitId && !t.voidedAt && covers(t.startDate, t.endDate, day),
      );
      if (tenancy)
        return {
          billTo: 'TENANTS' as const,
          tenancyId: tenancy.id,
          recipients: tenancy.occupants.map((o) => ({
            personId: o.personId,
            fullName: o.fullName,
            share: null,
          })),
        };
    }
    const owners = this.ownerRecipients(req.ownerships, unitId, day);
    return owners.length > 0
      ? { billTo: 'OWNERS' as const, tenancyId: null, recipients: owners }
      : null;
  }

  private draft(
    propertyId: string,
    unitId: string,
    billTo: Party,
    tenancyId: string | null,
    recipients: Invoice['recipients'],
    billingDate: string,
    dueDate: string,
    billingMonth: string | null,
  ): Invoice {
    const invoice: Invoice = {
      id: randomUUID(),
      propertyId,
      number: null,
      status: 'DRAFT',
      unitId,
      billTo,
      tenancyId,
      recipients,
      billingMonth,
      billingDate,
      dueDate,
      issueDate: null,
      lines: [],
      credits: [],
      createdAt: now(),
      issuedAt: null,
    };
    this.invoices.push(invoice);
    return invoice;
  }

  private period(propertyId: string, day: string) {
    let period = this.periods.find(
      (p) => p.propertyId === propertyId && p.startDate <= day && day <= p.endDate,
    );
    if (!period) {
      period = {
        id: randomUUID(),
        propertyId,
        startDate: `${day.slice(0, 7)}-01`,
        endDate: monthEnd(day.slice(0, 7)),
        status: 'OPEN',
        closedAt: null,
      };
      this.periods.push(period);
      this.periods.sort((a, b) => a.startDate.localeCompare(b.startDate));
    }
    return period;
  }

  private postable(propertyId: string, day: string): FinanceReply | null {
    return this.period(propertyId, day).status === 'CLOSED'
      ? fail(409, 'PERIOD_CLOSED', `The accounting period for ${day} is closed`)
      : null;
  }

  private issue(propertyId: string, invoice: Invoice, today: string): void {
    invoice.status = 'ISSUED';
    invoice.number = this.next(propertyId, 'INV');
    invoice.issueDate = today;
    invoice.issuedAt = now();
    this.period(propertyId, today);
    // Unit credit of the same party pays new invoices automatically.
    this.applyCredit(invoice, today);
  }

  private unused(p: Payment): bigint {
    if (p.reversedOn) return 0n;
    return p.amount - this.paidByPayment(p.id) - sum(p.refunded.map((r) => r.amount));
  }

  private paidByPayment(paymentId: string): bigint {
    return sum(
      this.allocations
        .filter((a) => a.paymentId === paymentId && !a.releasedAt)
        .map((a) => a.amount),
    );
  }

  private applyCredit(invoice: Invoice, today: string) {
    for (const p of this.payments.filter(
      (p) => p.unitId === invoice.unitId && p.paidBy === invoice.billTo,
    )) {
      const owed = this.invoiceTotals(invoice, today).outstanding;
      const left = this.unused(p);
      if (owed <= 0n) break;
      if (left > 0n)
        this.allocations.push({
          id: randomUUID(),
          paymentId: p.id,
          invoiceId: invoice.id,
          amount: min(owed, left),
          createdAt: now(),
          releasedAt: null,
        });
    }
  }

  private allocateOldestFirst(payment: Payment, today: string) {
    const open = this.invoices
      .filter(
        (i) => i.status === 'ISSUED' && i.unitId === payment.unitId && i.billTo === payment.paidBy,
      )
      .sort((a, b) => (a.dueDate + (a.number ?? '')).localeCompare(b.dueDate + (b.number ?? '')));
    for (const invoice of open) {
      const left = this.unused(payment);
      if (left <= 0n) break;
      const owed = this.invoiceTotals(invoice, today).outstanding;
      if (owed > 0n)
        this.allocations.push({
          id: randomUUID(),
          paymentId: payment.id,
          invoiceId: invoice.id,
          amount: min(owed, left),
          createdAt: now(),
          releasedAt: null,
        });
    }
  }

  // ------------------------------------------------------------------ routing

  handle(req: FinanceRequest): FinanceReply | null {
    const { method, body, url, property, today } = req;
    const sub = req.sub.replace(/^\/finance/, '');
    const can = (p: string) => req.permissions.includes(p);
    if (!can('property.finance.read')) return fail(403, 'FORBIDDEN');
    const manage = () => (can('property.finance.manage') ? null : fail(403, 'FORBIDDEN'));
    const str = (key: string) =>
      typeof body[key] === 'string' ? (body[key] as string).trim() : undefined;
    const pid = property.id;
    const mine = <T extends { propertyId: string }>(rows: T[]) =>
      rows.filter((r) => r.propertyId === pid);
    const setUp = mine(this.accounts).length > 0;
    const notSetUp = () => fail(409, 'FINANCE_NOT_SET_UP');
    const unitOf = (id: string | undefined) =>
      req.units.find((u) => u.id === id && u.propertyId === pid);

    if (sub === '/setup' && method === 'POST') {
      const denied = manage();
      if (denied) return denied;
      this.setUp(pid);
      return ok({ accounts: mine(this.accounts), chargeTypes: mine(this.chargeTypes) });
    }
    if (sub === '/accounts' && method === 'GET')
      return ok({ data: mine(this.accounts).map(({ propertyId: _, ...a }) => a) });

    // ---------------------------------------------------------------- charge types
    if (sub === '/charge-types') {
      if (method === 'GET')
        return ok({ data: mine(this.chargeTypes).map(({ propertyId: _, ...c }) => c) });
      const denied = manage();
      if (denied) return denied;
      if (!setUp) return notSetUp();
      const code = (str('code') ?? '').toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code) || !str('name'))
        return fail(400, 'VALIDATION_FAILED');
      if (mine(this.chargeTypes).some((c) => c.code === code)) return fail(409, 'CODE_TAKEN');
      const type = {
        id: randomUUID(),
        propertyId: pid,
        code,
        name: str('name') ?? '',
        liableParty:
          str('liableParty') === 'OCCUPANT' ? ('OCCUPANT' as const) : ('OWNERS' as const),
        incomeAccountId: str('incomeAccountId') ?? '',
        status: 'ACTIVE' as const,
      };
      this.chargeTypes.push(type);
      const { propertyId: _, ...dto } = type;
      return ok(dto, 201);
    }
    const archiveType = /^\/charge-types\/([^/]+)\/archive$/.exec(sub);
    if (archiveType && method === 'POST') {
      const denied = manage();
      if (denied) return denied;
      const type = mine(this.chargeTypes).find((c) => c.id === archiveType[1]);
      if (!type) return fail(404, 'NOT_FOUND');
      type.status = 'ARCHIVED';
      const { propertyId: _, ...dto } = type;
      return ok(dto);
    }

    // ---------------------------------------------------------------- recurring charges
    const recurringDto = (r: (typeof this.recurring)[number]): RecurringChargeDto => {
      const { propertyId: _, amount, ...rest } = r;
      return {
        ...rest,
        amount: this.money(amount),
        unitNumber: r.unitId ? (unitOf(r.unitId)?.number ?? null) : null,
        chargeTypeCode: this.chargeTypes.find((c) => c.id === r.chargeTypeId)?.code ?? '?',
      };
    };
    if (sub === '/recurring-charges') {
      if (method === 'GET') return ok({ data: mine(this.recurring).map(recurringDto) });
      const denied = manage();
      if (denied) return denied;
      const amount = parseMinor(str('amount'));
      const type = mine(this.chargeTypes).find(
        (c) => c.id === str('chargeTypeId') && c.status === 'ACTIVE',
      );
      const startMonth = str('startMonth') ?? '';
      const endMonth = str('endMonth') ?? null;
      if (!amount || !type || !/^\d{4}-\d{2}$/.test(startMonth))
        return fail(400, 'VALIDATION_FAILED');
      const unitId = str('unitId') ?? null;
      if (unitId && !unitOf(unitId)) return fail(404, 'NOT_FOUND');
      const overlap = mine(this.recurring).some(
        (r) =>
          r.chargeTypeId === type.id &&
          r.unitId === unitId &&
          r.startMonth <= (endMonth ?? '9999-12') &&
          startMonth <= (r.endMonth ?? '9999-12'),
      );
      if (overlap) return fail(409, 'OVERLAPPING_CHARGE');
      const charge = {
        id: randomUUID(),
        propertyId: pid,
        unitId,
        chargeTypeId: type.id,
        basis: str('basis') === 'PER_SQM' ? ('PER_SQM' as const) : ('FLAT' as const),
        amount,
        startMonth,
        endMonth,
      };
      this.recurring.push(charge);
      return ok(recurringDto(charge), 201);
    }
    const endCharge = /^\/recurring-charges\/([^/]+)\/end$/.exec(sub);
    if (endCharge && method === 'POST') {
      const denied = manage();
      if (denied) return denied;
      const charge = mine(this.recurring).find((r) => r.id === endCharge[1]);
      if (!charge) return fail(404, 'NOT_FOUND');
      const endMonth = str('endMonth') ?? '';
      if (endMonth < charge.startMonth || (charge.endMonth && endMonth > charge.endMonth))
        return fail(422, 'VALIDATION_FAILED', 'A charge can only end earlier, never be extended');
      charge.endMonth = endMonth;
      return ok(recurringDto(charge));
    }

    // ---------------------------------------------------------------- billing runs
    if (sub === '/billing-runs' && method === 'POST') {
      const denied = manage();
      if (denied) return denied;
      if (!setUp) return notSetUp();
      const month = str('month') ?? '';
      const dueDate = str('dueDate') ?? '';
      const billingDate = `${month}-01`;
      const created: Invoice[] = [];
      const skipped: {
        unitId: string;
        unitNumber: string;
        chargeTypeCode: string;
        reason: 'NO_AREA' | 'NO_OWNER';
      }[] = [];
      const billed = new Set(
        this.invoices.flatMap((i) => i.lines.map((l) => l.runKey)).filter(Boolean),
      );
      for (const unit of req.units.filter((u) => u.propertyId === pid && u.status === 'ACTIVE')) {
        const active = mine(this.recurring).filter(
          (r) => r.startMonth <= month && (!r.endMonth || month <= r.endMonth),
        );
        const forUnit = active.filter(
          (r) =>
            r.unitId === unit.id ||
            (r.unitId === null &&
              !active.some((o) => o.unitId === unit.id && o.chargeTypeId === r.chargeTypeId)),
        );
        for (const charge of forUnit) {
          const type = this.chargeTypes.find((c) => c.id === charge.chargeTypeId);
          if (!type) continue;
          const runKey = `${charge.chargeTypeId}:${unit.id}:${month}`;
          if (billed.has(runKey)) continue;
          let amount = charge.amount;
          if (charge.basis === 'PER_SQM') {
            if (!unit.areaSqm) {
              skipped.push({
                unitId: unit.id,
                unitNumber: unit.number,
                chargeTypeCode: type.code,
                reason: 'NO_AREA',
              });
              continue;
            }
            const [w = '0', f = ''] = unit.areaSqm.split('.');
            amount = (charge.amount * (BigInt(w) * 100n + BigInt(f.padEnd(2, '0'))) + 50n) / 100n;
          }
          const party = this.billParty(req, unit.id, type.liableParty, billingDate);
          if (!party) {
            skipped.push({
              unitId: unit.id,
              unitNumber: unit.number,
              chargeTypeCode: type.code,
              reason: 'NO_OWNER',
            });
            continue;
          }
          let invoice = created.find(
            (i) =>
              i.unitId === unit.id && i.billTo === party.billTo && i.tenancyId === party.tenancyId,
          );
          if (!invoice) {
            invoice = this.draft(
              pid,
              unit.id,
              party.billTo,
              party.tenancyId,
              party.recipients,
              billingDate,
              dueDate,
              month,
            );
            created.push(invoice);
          }
          invoice.lines.push({
            lineNumber: invoice.lines.length + 1,
            chargeTypeId: type.id,
            description: `${type.name}, ${month}`,
            amount,
            billingMonth: month,
            runKey,
          });
        }
      }
      if (body.issue === true) {
        const closed = this.postable(pid, today);
        if (closed) return closed;
        for (const invoice of created) this.issue(pid, invoice, today);
      }
      return ok(
        { month, invoices: created.map((i) => this.invoiceDto(i, req.units, today)), skipped },
        201,
      );
    }

    // ---------------------------------------------------------------- invoices
    if (sub === '/invoices') {
      if (method === 'GET') {
        const status = url.searchParams.get('status');
        const unitId = url.searchParams.get('unitId');
        const month = url.searchParams.get('billingMonth');
        const rows = mine(this.invoices)
          .filter(
            (i) =>
              (!status || i.status === status) &&
              (!unitId || i.unitId === unitId) &&
              (!month || i.billingMonth === month),
          )
          .reverse()
          .slice(0, 200);
        return ok({ data: rows.map((i) => this.invoiceDto(i, req.units, today)) });
      }
      const denied = manage();
      if (denied) return denied;
      if (!setUp) return notSetUp();
      const unit = unitOf(str('unitId'));
      if (!unit) return fail(404, 'NOT_FOUND');
      const lines = Array.isArray(body.lines) ? (body.lines as Record<string, string>[]) : [];
      const types = lines.map((l) =>
        mine(this.chargeTypes).find((c) => c.id === l.chargeTypeId && c.status === 'ACTIVE'),
      );
      const amounts = lines.map((l) => parseMinor(l.amount));
      if (lines.length === 0 || types.some((t) => !t) || amounts.some((a) => !a))
        return fail(400, 'VALIDATION_FAILED');
      const party = this.billParty(req, unit.id, types[0]?.liableParty ?? 'OWNERS', today);
      if (!party)
        return fail(422, 'NO_ONE_TO_BILL', 'This unit has nobody to bill for these charges');
      const invoice = this.draft(
        pid,
        unit.id,
        party.billTo,
        party.tenancyId,
        party.recipients,
        today,
        str('dueDate') ?? today,
        null,
      );
      for (const [index, l] of lines.entries()) {
        invoice.lines.push({
          lineNumber: index + 1,
          chargeTypeId: types[index]?.id ?? '',
          description: l.description ?? types[index]?.name ?? '',
          amount: amounts[index] ?? 0n,
          billingMonth: null,
          runKey: null,
        });
      }
      return ok(this.invoiceDetail(invoice, req.units, today), 201);
    }
    const invoiceMatch = /^\/invoices\/([^/]+)(\/[a-z-]+)?$/.exec(sub);
    if (invoiceMatch) {
      const invoice = mine(this.invoices).find((i) => i.id === invoiceMatch[1]);
      if (!invoice) return fail(404, 'NOT_FOUND');
      const action = invoiceMatch[2] ?? '';
      if (action === '' && method === 'GET')
        return ok(this.invoiceDetail(invoice, req.units, today));
      const denied = manage();
      if (denied) return denied;
      if (action === '/issue') {
        if (invoice.status === 'ISSUED') return fail(409, 'ALREADY_ISSUED');
        const closed = this.postable(pid, today);
        if (closed) return closed;
        if (str('dueDate')) invoice.dueDate = str('dueDate') ?? invoice.dueDate;
        this.issue(pid, invoice, today);
        return ok(this.invoiceDetail(invoice, req.units, today));
      }
      if (action === '/discard') {
        if (invoice.status === 'ISSUED') return fail(409, 'ALREADY_ISSUED');
        this.invoices = this.invoices.filter((i) => i !== invoice);
        return ok(undefined, 204);
      }
      if (action === '/credit-notes') {
        const amount = parseMinor(str('amount'));
        const line = invoice.lines.find((l) => l.lineNumber === body.lineNumber);
        if (!amount || !line || !str('reason')) return fail(400, 'VALIDATION_FAILED');
        if (invoice.status !== 'ISSUED')
          return fail(422, 'VALIDATION_FAILED', 'Only issued invoices can be credited');
        const credited = sum(
          invoice.credits.filter((c) => c.lineNumber === line.lineNumber).map((c) => c.amount),
        );
        if (
          amount > line.amount - credited ||
          amount > this.invoiceTotals(invoice, today).outstanding
        )
          return fail(
            422,
            'VALIDATION_FAILED',
            'That is more than this invoice still owes; release payments first',
          );
        const closed = this.postable(pid, today);
        if (closed) return closed;
        invoice.credits.push({
          id: randomUUID(),
          kind: 'CREDIT_NOTE',
          number: this.next(pid, 'CRN'),
          lineNumber: line.lineNumber,
          amount,
          reason: str('reason') ?? '',
          creditedOn: today,
        });
        return ok(this.invoiceDetail(invoice, req.units, today), 201);
      }
    }

    // ---------------------------------------------------------------- payments
    // ---------------------------------------------------------------- residents' bank transfers
    if (sub === '/bank-transfers' && method === 'GET') {
      const status = url.searchParams.get('status');
      return ok({
        data: mine(this.transfers)
          .filter((t) => !status || t.status === status)
          .reverse()
          .map((t) => this.transferDto(t, req.units)),
      });
    }
    const decideTransfer = /^\/bank-transfers\/([^/]+)\/(confirm|reject)$/.exec(sub);
    if (decideTransfer && method === 'POST') {
      const denied = manage();
      if (denied) return denied;
      const transfer = mine(this.transfers).find((t) => t.id === decideTransfer[1]);
      if (!transfer) return fail(404, 'NOT_FOUND');
      if (transfer.status !== 'PENDING') return fail(409, 'ALREADY_DECIDED');
      if (transfer.submittedBy.userId === req.user.id) return fail(403, 'SAME_PERSON');
      if (decideTransfer[2] === 'reject') {
        const reason = str('reason');
        if (!reason) return fail(400, 'VALIDATION_FAILED');
        Object.assign(transfer, { status: 'REJECTED', rejectionReason: reason, decidedAt: now() });
        return ok(this.transferDto(transfer, req.units));
      }
      const receivedOn = str('receivedOn') ?? transfer.transferredOn;
      if (receivedOn > today)
        return fail(422, 'VALIDATION_FAILED', 'A payment cannot be received in the future');
      const closed = this.postable(pid, receivedOn);
      if (closed) return closed;
      const payment: Payment = {
        id: randomUUID(),
        propertyId: pid,
        receiptNumber: this.next(pid, 'RCT'),
        unitId: transfer.unitId,
        paidBy: transfer.paidBy,
        method: 'BANK_TRANSFER',
        amount: transfer.amount,
        refunded: [],
        reversedOn: null,
        receivedOn,
        reference: transfer.reference,
        idempotencyKey: null,
        requestHash: '',
        createdAt: now(),
      };
      this.payments.push(payment);
      this.allocateOldestFirst(payment, today);
      Object.assign(transfer, { status: 'CONFIRMED', paymentId: payment.id, decidedAt: now() });
      return ok(this.transferDto(transfer, req.units));
    }

    if (sub === '/payments') {
      if (method === 'GET') {
        const unitId = url.searchParams.get('unitId');
        return ok({
          data: mine(this.payments)
            .filter((p) => !unitId || p.unitId === unitId)
            .reverse()
            .map((p) => this.paymentDto(p, req.units)),
        });
      }
      const denied = manage();
      if (denied) return denied;
      if (!setUp) return notSetUp();
      const key = req.idempotencyKey;
      if (!key || !/^[0-9a-f-]{36}$/i.test(key)) return fail(400, 'IDEMPOTENCY_KEY_REQUIRED');
      const requestHash = JSON.stringify(body);
      const earlier = this.payments.find((p) => p.idempotencyKey === key);
      if (earlier) {
        return earlier.requestHash === requestHash
          ? ok(this.paymentDto(earlier, req.units))
          : fail(409, 'IDEMPOTENCY_KEY_REUSED');
      }
      const unit = unitOf(str('unitId'));
      if (!unit) return fail(404, 'NOT_FOUND');
      const amount = parseMinor(str('amount'));
      const receivedOn = str('receivedOn') ?? '';
      if (!amount || !/^\d{4}-\d{2}-\d{2}$/.test(receivedOn)) return fail(400, 'VALIDATION_FAILED');
      if (receivedOn > today)
        return fail(422, 'VALIDATION_FAILED', 'The money cannot be received in the future');
      const closed = this.postable(pid, receivedOn);
      if (closed) return closed;
      const payment: Payment = {
        id: randomUUID(),
        propertyId: pid,
        receiptNumber: this.next(pid, 'RCT'),
        unitId: unit.id,
        paidBy: str('paidBy') === 'TENANTS' ? 'TENANTS' : 'OWNERS',
        method: (str('method') ?? 'CASH') as Payment['method'],
        amount,
        refunded: [],
        reversedOn: null,
        receivedOn,
        reference: str('reference') ?? null,
        idempotencyKey: key,
        requestHash,
        createdAt: now(),
      };
      this.payments.push(payment);
      this.allocateOldestFirst(payment, today);
      return ok(this.paymentDto(payment, req.units), 201);
    }
    const paymentMatch = /^\/payments\/([^/]+)(\/allocations)?$/.exec(sub);
    if (paymentMatch) {
      const payment = mine(this.payments).find((p) => p.id === paymentMatch[1]);
      if (!payment) return fail(404, 'NOT_FOUND');
      if (!paymentMatch[2] && method === 'GET') return ok(this.paymentDto(payment, req.units));
      if (paymentMatch[2] && method === 'POST') {
        const denied = manage();
        if (denied) return denied;
        if (payment.reversedOn) return fail(409, 'PAYMENT_REVERSED');
        const invoice = mine(this.invoices).find((i) => i.id === str('invoiceId'));
        const amount = parseMinor(str('amount'));
        if (!invoice || !amount) return fail(400, 'VALIDATION_FAILED');
        if (
          invoice.status !== 'ISSUED' ||
          invoice.unitId !== payment.unitId ||
          invoice.billTo !== payment.paidBy
        )
          return fail(
            422,
            'VALIDATION_FAILED',
            'The invoice must be an issued invoice of the same unit and party',
          );
        if (amount > this.unused(payment))
          return fail(422, 'VALIDATION_FAILED', 'That is more than what is left of this payment');
        if (amount > this.invoiceTotals(invoice, today).outstanding)
          return fail(422, 'VALIDATION_FAILED', 'That is more than the invoice still owes');
        this.allocations.push({
          id: randomUUID(),
          paymentId: payment.id,
          invoiceId: invoice.id,
          amount,
          createdAt: now(),
          releasedAt: null,
        });
        return ok(this.paymentDto(payment, req.units), 201);
      }
    }
    const release = /^\/allocations\/([^/]+)\/release$/.exec(sub);
    if (release && method === 'POST') {
      const denied = manage();
      if (denied) return denied;
      const allocation = this.allocations.find((a) => a.id === release[1]);
      const payment = allocation && mine(this.payments).find((p) => p.id === allocation.paymentId);
      if (!allocation || !payment) return fail(404, 'NOT_FOUND');
      if (allocation.releasedAt) return fail(409, 'ALREADY_RELEASED');
      allocation.releasedAt = now();
      return ok(this.paymentDto(payment, req.units));
    }

    // ---------------------------------------------------------------- periods
    if (sub === '/periods' && method === 'GET')
      return ok({ data: mine(this.periods).map(({ propertyId: _, ...p }) => p) });
    const closePeriod = /^\/periods\/([^/]+)\/close$/.exec(sub);
    if (closePeriod && method === 'POST') {
      const denied = manage();
      if (denied) return denied;
      const period = mine(this.periods).find((p) => p.id === closePeriod[1]);
      if (!period) return fail(404, 'NOT_FOUND');
      if (period.status === 'CLOSED') return fail(409, 'ALREADY_CLOSED');
      period.status = 'CLOSED';
      period.closedAt = now();
      const { propertyId: _, ...dto } = period;
      return ok(dto);
    }

    // ---------------------------------------------------------------- approvals
    if (sub === '/approvals') {
      if (method === 'GET') {
        const status = url.searchParams.get('status');
        return ok({
          data: mine(this.approvals)
            .filter((a) => !status || a.status === status)
            .reverse()
            .map((a) => this.approvalDto(a)),
        });
      }
      const denied = manage();
      if (denied) return denied;
      const action = str('action') as FinanceApprovalDto['action'];
      const reason = str('reason');
      if (!reason) return fail(400, 'VALIDATION_FAILED');
      const approval: Approval = {
        id: randomUUID(),
        propertyId: pid,
        action,
        status: 'PENDING',
        paymentId: null,
        invoiceId: null,
        periodId: null,
        amount: null,
        refundMethod: null,
        reason,
        requestedBy: { userId: req.user.id, name: req.user.displayName },
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
        createdAt: now(),
      };
      const checked = this.check(approval, body, req);
      if (checked) return checked;
      this.approvals.push(approval);
      return ok(this.approvalDto(approval), 201);
    }
    const decide = /^\/approvals\/([^/]+)\/(approve|reject|cancel)$/.exec(sub);
    if (decide && method === 'POST') {
      const approval = mine(this.approvals).find((a) => a.id === decide[1]);
      if (!approval) return fail(404, 'NOT_FOUND');
      const verb = decide[2];
      if (verb === 'cancel') {
        const denied = manage();
        if (denied) return denied;
        if (approval.requestedBy.userId !== req.user.id) return fail(403, 'NOT_REQUESTER');
      } else {
        if (!can('property.finance.approve')) return fail(403, 'FORBIDDEN');
        if (approval.requestedBy.userId === req.user.id)
          return fail(403, 'SAME_PERSON', 'Someone other than the requester must approve this');
      }
      if (approval.status !== 'PENDING') return fail(409, 'ALREADY_DECIDED');
      if (verb === 'approve') {
        const failed = this.carryOut(approval, req);
        if (failed) return failed;
      }
      approval.status =
        verb === 'approve' ? 'APPROVED' : verb === 'reject' ? 'REJECTED' : 'CANCELLED';
      approval.decidedBy = { userId: req.user.id, name: req.user.displayName };
      approval.decidedAt = now();
      approval.decisionNote = verb === 'cancel' ? null : (str('note') ?? null);
      return ok(this.approvalDto(approval));
    }

    // ---------------------------------------------------------------- reports
    const statement = /^\/units\/([^/]+)\/statement$/.exec(sub);
    if (statement && method === 'GET') {
      const unit = unitOf(statement[1]);
      if (!unit) return fail(404, 'NOT_FOUND');
      const paidBy = url.searchParams.get('paidBy') === 'TENANTS' ? 'TENANTS' : 'OWNERS';
      return ok(this.statement(pid, unit, paidBy, today));
    }
    if (sub === '/ageing' && method === 'GET')
      return ok(this.ageing(pid, req.units, url.searchParams.get('asOf') ?? today, today));
    return fail(404, 'NOT_FOUND');
  }

  /** Checks a request for approval now; it is checked again when approved. */
  private check(
    a: Approval,
    body: Record<string, unknown>,
    req: FinanceRequest,
  ): FinanceReply | null {
    const pid = req.property.id;
    if (a.action === 'WRITE_OFF') {
      const invoice = this.invoices.find((i) => i.id === body.invoiceId && i.propertyId === pid);
      const amount = parseMinor(body.amount);
      if (!invoice || !amount) return fail(400, 'VALIDATION_FAILED');
      if (amount > this.invoiceTotals(invoice, req.today).outstanding)
        return fail(422, 'VALIDATION_FAILED', 'That is more than the invoice still owes');
      a.invoiceId = invoice.id;
      a.amount = amount;
      return null;
    }
    if (a.action === 'REOPEN_PERIOD') {
      const period = this.periods.find((p) => p.id === body.periodId && p.propertyId === pid);
      if (!period) return fail(404, 'NOT_FOUND');
      if (period.status !== 'CLOSED') return fail(409, 'NOT_CLOSED');
      a.periodId = period.id;
      return null;
    }
    const payment = this.payments.find((p) => p.id === body.paymentId && p.propertyId === pid);
    if (!payment) return fail(404, 'NOT_FOUND');
    if (payment.reversedOn) return fail(409, 'PAYMENT_REVERSED');
    a.paymentId = payment.id;
    if (a.action === 'REVERSE_PAYMENT') {
      return payment.refunded.length > 0 ? fail(409, 'PAYMENT_REFUNDED') : null;
    }
    const amount = parseMinor(body.amount);
    if (!amount) return fail(400, 'VALIDATION_FAILED');
    if (amount > this.unused(payment))
      return fail(422, 'VALIDATION_FAILED', 'That is more than what is unused of this payment');
    a.amount = amount;
    a.refundMethod = (body.method as Approval['refundMethod']) ?? 'BANK_TRANSFER';
    return null;
  }

  private carryOut(a: Approval, req: FinanceRequest): FinanceReply | null {
    const today = req.today;
    if (a.action === 'REOPEN_PERIOD') {
      const period = this.periods.find((p) => p.id === a.periodId);
      if (period?.status !== 'CLOSED') return fail(409, 'NOT_CLOSED');
      period.status = 'OPEN';
      period.closedAt = null;
      return null;
    }
    const closed = this.postable(req.property.id, today);
    if (closed) return closed;
    if (a.action === 'WRITE_OFF') {
      const invoice = this.invoices.find((i) => i.id === a.invoiceId);
      if (!invoice || (a.amount ?? 0n) > this.invoiceTotals(invoice, today).outstanding)
        return fail(409, 'NO_LONGER_OWED');
      invoice.credits.push({
        id: randomUUID(),
        kind: 'WRITE_OFF',
        number: null,
        lineNumber: null,
        amount: a.amount ?? 0n,
        reason: a.reason,
        creditedOn: today,
      });
      return null;
    }
    const payment = this.payments.find((p) => p.id === a.paymentId);
    if (!payment) return fail(404, 'NOT_FOUND');
    if (payment.reversedOn) return fail(409, 'PAYMENT_REVERSED');
    if (a.action === 'REFUND') {
      if ((a.amount ?? 0n) > this.unused(payment)) return fail(409, 'NO_LONGER_UNUSED');
      payment.refunded.push({ amount: a.amount ?? 0n, on: today });
      return null;
    }
    for (const allocation of this.allocations.filter(
      (x) => x.paymentId === payment.id && !x.releasedAt,
    ))
      allocation.releasedAt = now();
    payment.reversedOn = today;
    return null;
  }

  private statement(pid: string, unit: UnitDto, paidBy: Party, today: string): StatementDto {
    const raw: {
      date: string;
      kind: StatementLineDto['kind'];
      reference: string;
      debit: bigint;
      credit: bigint;
    }[] = [];
    for (const i of this.invoices.filter(
      (i) =>
        i.propertyId === pid &&
        i.unitId === unit.id &&
        i.billTo === paidBy &&
        i.status === 'ISSUED',
    )) {
      raw.push({
        date: i.issueDate ?? today,
        kind: 'INVOICE',
        reference: i.number ?? '',
        debit: sum(i.lines.map((l) => l.amount)),
        credit: 0n,
      });
      for (const c of i.credits)
        raw.push({
          date: c.creditedOn,
          kind: c.kind,
          reference: c.number ?? i.number ?? '',
          debit: 0n,
          credit: c.amount,
        });
    }
    for (const p of this.payments.filter(
      (p) => p.propertyId === pid && p.unitId === unit.id && p.paidBy === paidBy,
    )) {
      raw.push({
        date: p.receivedOn,
        kind: 'PAYMENT',
        reference: p.receiptNumber,
        debit: 0n,
        credit: p.amount,
      });
      for (const r of p.refunded)
        raw.push({
          date: r.on,
          kind: 'REFUND',
          reference: p.receiptNumber,
          debit: r.amount,
          credit: 0n,
        });
      if (p.reversedOn)
        raw.push({
          date: p.reversedOn,
          kind: 'PAYMENT_REVERSAL',
          reference: p.receiptNumber,
          debit: p.amount,
          credit: 0n,
        });
    }
    raw.sort((a, b) => a.date.localeCompare(b.date));
    let balance = 0n;
    const lines = raw.map((l) => {
      balance += l.debit - l.credit;
      return {
        date: l.date,
        kind: l.kind,
        reference: l.reference,
        debit: this.money(l.debit),
        credit: this.money(l.credit),
        balance: this.money(balance),
      };
    });
    return {
      unitId: unit.id,
      unitNumber: unit.number,
      paidBy,
      tenancyId: null,
      asOf: today,
      lines,
      balance: this.money(balance),
    };
  }

  private ageing(pid: string, units: UnitDto[], asOf: string, today: string): AgeingDto {
    const zero = () => ({ current: 0n, days1to30: 0n, days31to60: 0n, days61to90: 0n, over90: 0n });
    const rows = new Map<
      string,
      { unitId: string; billTo: Party; tenancyId: string | null; buckets: ReturnType<typeof zero> }
    >();
    const totals = zero();
    for (const i of this.invoices.filter((i) => i.propertyId === pid && i.status === 'ISSUED')) {
      const owed = this.invoiceTotals(i, today).outstanding;
      if (owed <= 0n) continue;
      const late = Math.floor((Date.parse(asOf) - Date.parse(i.dueDate)) / DAY);
      const bucket =
        late <= 0
          ? 'current'
          : late <= 30
            ? 'days1to30'
            : late <= 60
              ? 'days31to60'
              : late <= 90
                ? 'days61to90'
                : 'over90';
      const key = `${i.unitId}:${i.billTo}:${i.tenancyId ?? ''}`;
      const row = rows.get(key) ?? {
        unitId: i.unitId,
        billTo: i.billTo,
        tenancyId: i.tenancyId,
        buckets: zero(),
      };
      row.buckets[bucket] += owed;
      totals[bucket] += owed;
      rows.set(key, row);
    }
    const buckets = (b: ReturnType<typeof zero>) => ({
      current: this.money(b.current),
      days1to30: this.money(b.days1to30),
      days31to60: this.money(b.days31to60),
      days61to90: this.money(b.days61to90),
      over90: this.money(b.over90),
    });
    return {
      asOf,
      rows: [...rows.values()].map((r) => ({
        unitId: r.unitId,
        unitNumber: units.find((u) => u.id === r.unitId)?.number ?? '?',
        billTo: r.billTo,
        tenancyId: r.tenancyId,
        buckets: buckets(r.buckets),
        total: this.money(sum(Object.values(r.buckets))),
      })),
      totals: buckets(totals),
    };
  }
}
