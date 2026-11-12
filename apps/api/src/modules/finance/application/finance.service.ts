import { Inject, Injectable } from '@nestjs/common';
import { databaseErrorCode } from '@veyra/db';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import type { OrganisationAccess } from '../../access-control';
import {
  type BillingRunInput,
  type BillTo,
  billToKey,
  type CreateChargeTypeInput,
  type CreateInvoiceInput,
  type CreateRecurringChargeInput,
  chargesForUnit,
  DEFAULT_ACCOUNTS,
  DEFAULT_CHARGE_TYPES,
  type InvoiceListQuery,
  type IsoDate,
  monthLabel,
  parsePositiveAmount,
  recurringAmount,
  resolveBillTo,
} from '../domain/finance-rules';
import { applyCredit, requireOpenPeriod, systemAccount } from './credit';
import {
  AlreadyBilled,
  FINANCE_REPOSITORY,
  type FinanceRepository,
  type FinanceUnitOfWork,
  type InvoiceDetailRecord,
  type NewInvoice,
  type NewLedgerLine,
  type PropertyFinanceInfo,
} from './finance-ports';

const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);
const invalid = (message: string) => new ApiError(422, 'VALIDATION_FAILED', message);

export interface BillingRunSkipRecord {
  unitId: string;
  unitNumber: string;
  chargeTypeCode: string;
  reason: 'NO_AREA' | 'NO_OWNER';
}

type InvoiceDraftLine = NewInvoice['lines'][number];

/**
 * Billing (Phase 6 Part 2): the property's chart of accounts, charge types, recurring charges,
 * monthly billing runs and invoices. Issuing an invoice posts its ledger entry (debit the unit's
 * receivables, credit each charge type's income account) in the same transaction; the database
 * checks that the two match and that nothing issued changes again.
 */
@Injectable()
export class FinanceService {
  constructor(@Inject(FINANCE_REPOSITORY) private readonly repository: FinanceRepository) {}

  // ------------------------------------------------------------------ set-up and accounts

  /** Creates the default accounts and charge types that are missing. Safe to repeat. */
  setUp(access: OrganisationAccess, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const created = await uow.createAccounts(DEFAULT_ACCOUNTS);
      const accounts = await uow.accounts();
      let chargeTypes = 0;
      for (const definition of DEFAULT_CHARGE_TYPES) {
        if (await uow.chargeTypeByCode(definition.code)) continue;
        const income = accounts.find(
          (a) => a.systemKey === definition.incomeSystemKey && a.status === 'ACTIVE',
        );
        if (!income) continue;
        await uow.createChargeType({
          code: definition.code,
          name: definition.name,
          liableParty: definition.liableParty,
          incomeAccountId: income.id,
        });
        chargeTypes += 1;
      }
      if (created > 0 || chargeTypes > 0) {
        await uow.audit({
          action: 'finance.set_up',
          resourceType: 'property',
          resourceId: this.propertyOf(access),
          metadata: { accountsCreated: created, chargeTypesCreated: chargeTypes },
        });
      }
      return { accounts, chargeTypes: await uow.chargeTypes() };
    });
  }

  accounts(access: OrganisationAccess, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => uow.accounts());
  }

  // ------------------------------------------------------------------ charge types

  chargeTypes(access: OrganisationAccess, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => uow.chargeTypes());
  }

  createChargeType(access: OrganisationAccess, input: CreateChargeTypeInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const account = (await uow.accounts()).find((a) => a.id === input.incomeAccountId);
      // Income, or a liability for money held such as deposits (never the units' credit).
      const bookable =
        account?.type === 'INCOME' ||
        (account?.type === 'LIABILITY' && account.systemKey !== 'UNIT_CREDIT');
      if (!account || !bookable || account.status !== 'ACTIVE') {
        throw invalid(
          'Choose an active income account (or a liability for money held) of this property',
        );
      }
      if (await uow.chargeTypeByCode(input.code)) {
        throw new ApiError(409, 'CODE_TAKEN', 'A charge type with this code already exists');
      }
      const chargeType = await uow.createChargeType(input);
      await uow.audit({
        action: 'charge_type.created',
        resourceType: 'charge_type',
        resourceId: chargeType.id,
        metadata: { code: chargeType.code, liableParty: chargeType.liableParty },
      });
      return chargeType;
    });
  }

  /** Archived types are not billed by runs and cannot be used on new invoices. */
  archiveChargeType(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const chargeType = await uow.chargeType(id);
      if (!chargeType) throw notFound('Charge type');
      if (chargeType.status === 'ARCHIVED') return chargeType;
      const archived = await uow.archiveChargeType(id);
      await uow.audit({
        action: 'charge_type.archived',
        resourceType: 'charge_type',
        resourceId: id,
      });
      return archived;
    });
  }

  // ------------------------------------------------------------------ recurring charges

  recurringCharges(access: OrganisationAccess, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => uow.recurringCharges());
  }

  createRecurringCharge(
    access: OrganisationAccess,
    input: CreateRecurringChargeInput,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      const property = await uow.property();
      if (input.unitId) {
        const unit = await uow.unit(input.unitId);
        if (!unit) throw notFound('Unit');
        if (unit.status === 'ARCHIVED')
          throw new ApiError(409, 'ARCHIVED', 'This unit is archived');
      }
      const chargeType = await uow.chargeType(input.chargeTypeId);
      if (!chargeType) throw notFound('Charge type');
      if (chargeType.status === 'ARCHIVED') {
        throw new ApiError(409, 'ARCHIVED', 'This charge type is archived');
      }
      const amountMinor = parsePositiveAmount(input.amount, property.currency);
      try {
        const id = await uow.createRecurringCharge({
          unitId: input.unitId ?? null,
          chargeTypeId: input.chargeTypeId,
          basis: input.basis,
          amountMinor,
          startMonth: input.startMonth,
          endMonth: input.endMonth ?? null,
        });
        await uow.audit({
          action: 'recurring_charge.created',
          resourceType: 'recurring_charge',
          resourceId: id,
          metadata: {
            chargeType: chargeType.code,
            basis: input.basis,
            amountMinor: amountMinor.toString(),
            startMonth: input.startMonth,
            ...(input.unitId ? { unitId: input.unitId } : {}),
          },
        });
        const created = await uow.recurringCharge(id);
        if (!created) throw new Error('Recurring charge vanished inside its own transaction');
        return created;
      } catch (error) {
        throw databaseErrorCode(error) === '23P01' ? overlapping() : error;
      }
    });
  }

  /** Stops a recurring charge after the given month (already billed months stay billed). */
  endRecurringCharge(access: OrganisationAccess, id: string, endMonth: IsoDate, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const charge = await uow.recurringCharge(id);
      if (!charge) throw notFound('Recurring charge');
      if (endMonth < charge.startMonth) {
        throw invalid('The last month cannot be before the first month billed');
      }
      if (charge.endMonth !== null && endMonth > charge.endMonth) {
        throw invalid('A recurring charge can only be ended earlier; add a new one to extend it');
      }
      await uow.endRecurringCharge(id, endMonth);
      await uow.audit({
        action: 'recurring_charge.ended',
        resourceType: 'recurring_charge',
        resourceId: id,
        metadata: { endMonth },
      });
      const ended = await uow.recurringCharge(id);
      if (!ended) throw new Error('Recurring charge vanished inside its own transaction');
      return ended;
    });
  }

  // ------------------------------------------------------------------ billing runs

  /**
   * Bills every active unit for the month's recurring charges that are not billed yet: one
   * invoice per unit and party (owners, or the tenancy). Units that cannot be billed are reported,
   * not guessed. Running it again bills only what is new; the database refuses double billing.
   */
  runBilling(access: OrganisationAccess, input: BillingRunInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const property = await uow.property();
      const [charges, units, billed] = await Promise.all([
        uow.chargesForMonth(input.month),
        uow.activeUnits(),
        uow.billedForMonth(input.month),
      ]);
      const parties = await uow.parties(
        units.map((u) => u.id),
        input.month,
      );
      const skipped: BillingRunSkipRecord[] = [];
      const drafts: NewInvoice[] = [];

      for (const unit of units) {
        const groups = new Map<string, { target: BillTo; lines: InvoiceDraftLine[] }>();
        for (const charge of chargesForUnit(charges, unit.id)) {
          if (billed.has(`${charge.id}:${unit.id}`)) continue;
          const skip = (reason: BillingRunSkipRecord['reason']) =>
            skipped.push({
              unitId: unit.id,
              unitNumber: unit.number,
              chargeTypeCode: charge.chargeTypeCode,
              reason,
            });
          const amountMinor = recurringAmount(charge, unit.areaSqm);
          if (amountMinor === null) {
            skip('NO_AREA');
            continue;
          }
          const unitParties = parties.get(unit.id) ?? { owners: [], tenancy: null };
          const target = resolveBillTo(charge.liableParty, unitParties);
          if (!target) {
            skip('NO_OWNER');
            continue;
          }
          const key = billToKey(target);
          const group = groups.get(key) ?? { target, lines: [] };
          group.lines.push({
            chargeTypeId: charge.chargeTypeId,
            description: `${charge.chargeTypeName}, ${monthLabel(input.month)}`,
            amountMinor,
            recurringChargeId: charge.id,
          });
          groups.set(key, group);
        }
        for (const { target, lines } of groups.values()) {
          drafts.push({
            unitId: unit.id,
            billTo: target.billTo,
            tenancyId: target.tenancyId,
            billingMonth: input.month,
            billingDate: input.month,
            dueDate: input.dueDate,
            currency: property.currency,
            lines,
            recipients: recipientsOf(target),
          });
        }
      }

      const ids: string[] = [];
      for (const draft of drafts) ids.push(await uow.createInvoice(draft));
      if (input.issue) {
        for (const id of ids) await this.issueWithin(uow, property, id, undefined);
      }
      await uow.audit({
        action: 'billing_run.completed',
        resourceType: 'property',
        resourceId: this.propertyOf(access),
        metadata: {
          month: input.month,
          invoices: ids.length,
          skipped: skipped.length,
          issued: input.issue,
        },
      });
      const invoices: InvoiceDetailRecord[] = [];
      for (const id of ids) {
        const invoice = await uow.invoice(id);
        if (invoice) invoices.push(invoice);
      }
      return { month: input.month, invoices, skipped };
    });
  }

  // ------------------------------------------------------------------ invoices

  /** A one-off invoice for one unit, billed to the party its charge types name, as of today. */
  createInvoice(access: OrganisationAccess, input: CreateInvoiceInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const property = await uow.property();
      const id = await this.draftWithin(
        uow,
        property,
        input.unitId,
        input.lines.map((line) => ({
          chargeTypeId: line.chargeTypeId,
          description: line.description,
          amountMinor: parsePositiveAmount(line.amount, property.currency),
        })),
        input.dueDate,
      );
      return this.mustFind(uow, id);
    });
  }

  /**
   * Drafts a one-off invoice inside a finance unit of work (also used for facility bookings):
   * billed to the party the charge types name as of today, in the property's currency.
   */
  async draftWithin(
    uow: FinanceUnitOfWork,
    property: PropertyFinanceInfo,
    unitId: string,
    inputLines: readonly {
      chargeTypeId: string;
      description?: string | undefined;
      amountMinor: bigint;
    }[],
    dueDate: IsoDate,
  ): Promise<string> {
    const input = { unitId, dueDate, lines: inputLines };
    if (input.dueDate < property.today) throw invalid('The due date cannot be in the past');
    const unit = await uow.unit(input.unitId);
    if (!unit) throw notFound('Unit');
    if (unit.status === 'ARCHIVED') throw new ApiError(409, 'ARCHIVED', 'This unit is archived');
    const parties = (await uow.parties([unit.id], property.today)).get(unit.id) ?? {
      owners: [],
      tenancy: null,
    };

    let target: BillTo | null = null;
    const lines: InvoiceDraftLine[] = [];
    for (const line of input.lines) {
      const chargeType = await uow.chargeType(line.chargeTypeId);
      if (!chargeType) throw notFound('Charge type');
      if (chargeType.status === 'ARCHIVED') {
        throw new ApiError(409, 'ARCHIVED', `Charge type ${chargeType.code} is archived`);
      }
      const lineTarget = resolveBillTo(chargeType.liableParty, parties);
      if (!lineTarget) {
        throw new ApiError(409, 'NO_ONE_TO_BILL', 'This unit has nobody to bill for these charges');
      }
      if (target && billToKey(target) !== billToKey(lineTarget)) {
        throw invalid('These charges are billed to different people; create separate invoices');
      }
      target = lineTarget;
      lines.push({
        chargeTypeId: chargeType.id,
        description: line.description ?? chargeType.name,
        amountMinor: line.amountMinor,
        recurringChargeId: null,
      });
    }
    if (!target) throw invalid('Add at least one line');

    const id = await uow.createInvoice({
      unitId: unit.id,
      billTo: target.billTo,
      tenancyId: target.tenancyId,
      billingMonth: null,
      billingDate: property.today,
      dueDate: input.dueDate,
      currency: property.currency,
      lines,
      recipients: recipientsOf(target),
    });
    await uow.audit({
      action: 'invoice.created',
      resourceType: 'invoice',
      resourceId: id,
      metadata: { unitId: unit.id, lines: lines.length },
    });
    return id;
  }

  invoices(access: OrganisationAccess, filter: InvoiceListQuery, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => uow.invoices(filter));
  }

  invoice(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const invoice = await uow.invoice(id);
      if (!invoice) throw notFound('Invoice');
      return invoice;
    });
  }

  issueInvoice(
    access: OrganisationAccess,
    id: string,
    dueDate: IsoDate | undefined,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      await this.issueWithin(uow, await uow.property(), id, dueDate);
      return this.mustFind(uow, id);
    });
  }

  /** Discards a draft. Issued invoices are corrected with credit notes (Phase 6 Part 4). */
  discardInvoice(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const invoice = await uow.invoice(id, { lock: true });
      if (!invoice) throw notFound('Invoice');
      if (invoice.status !== 'DRAFT') {
        throw new ApiError(409, 'ALREADY_ISSUED', 'Issued invoices cannot be discarded');
      }
      await uow.deleteDraftInvoice(id);
      await uow.audit({
        action: 'invoice.discarded',
        resourceType: 'invoice',
        resourceId: id,
        metadata: { unitId: invoice.unitId, totalMinor: invoice.totalMinor.toString() },
      });
    });
  }

  /**
   * Issues a draft: today (property-local) becomes the issue date and the ledger date; the month's
   * accounting period is opened if no period covers today; the entry debits the unit's receivables
   * with the total and credits each charge type's income account with its lines.
   */
  async issueWithin(
    uow: FinanceUnitOfWork,
    property: PropertyFinanceInfo,
    id: string,
    newDueDate: IsoDate | undefined,
  ): Promise<void> {
    const invoice = await uow.invoice(id, { lock: true });
    if (!invoice) throw notFound('Invoice');
    if (invoice.status !== 'DRAFT') {
      throw new ApiError(409, 'ALREADY_ISSUED', 'This invoice is already issued');
    }
    const today = property.today;
    const dueDate = newDueDate ?? invoice.dueDate;
    if (dueDate < today) {
      throw invalid('The due date is before today; give a new due date to issue this invoice');
    }
    if (dueDate < invoice.billingDate) {
      throw invalid('The due date cannot be before the billing date');
    }
    if (dueDate !== invoice.dueDate) await uow.setDueDate(id, dueDate);

    await requireOpenPeriod(uow, today);
    const accounts = await uow.accounts();
    const receivables = systemAccount(accounts, 'RECEIVABLES');
    const income = new Map<string, bigint>();
    for (const line of invoice.lines) {
      income.set(line.incomeAccountId, (income.get(line.incomeAccountId) ?? 0n) + line.amountMinor);
    }
    for (const accountId of income.keys()) {
      if (!accounts.some((a) => a.id === accountId && a.status === 'ACTIVE')) {
        throw new ApiError(
          409,
          'ARCHIVED',
          'A charge on this invoice books to an archived account',
        );
      }
    }
    const lines: NewLedgerLine[] = [
      {
        accountId: receivables.id,
        unitId: invoice.unitId,
        debitMinor: invoice.totalMinor,
        creditMinor: 0n,
      },
      ...[...income].map(([accountId, amount]) => ({
        accountId,
        unitId: null,
        debitMinor: 0n,
        creditMinor: amount,
      })),
    ];
    const entryId = await uow.postEntry(
      'INVOICE',
      `Invoice for unit ${invoice.unitNumber}`,
      today,
      invoice.currency,
      lines,
    );
    await uow.markIssued(id, entryId, today);
    // Credit the same party already has goes to the new invoice at once (owner decision).
    await applyCredit(uow, {
      unitId: invoice.unitId,
      party: { billTo: invoice.billTo, tenancyId: invoice.tenancyId },
      date: today,
      currency: invoice.currency,
    });
    await uow.audit({
      action: 'invoice.issued',
      resourceType: 'invoice',
      resourceId: id,
      metadata: {
        unitId: invoice.unitId,
        totalMinor: invoice.totalMinor.toString(),
        journalEntryId: entryId,
      },
    });
  }

  private async mustFind(uow: FinanceUnitOfWork, id: string): Promise<InvoiceDetailRecord> {
    const invoice = await uow.invoice(id);
    if (!invoice) throw new Error('Invoice vanished inside its own transaction');
    return invoice;
  }

  private propertyOf(access: OrganisationAccess): string {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    return access.propertyId;
  }

  private async inProperty<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: FinanceUnitOfWork) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.repository.inProperty(
        access.organisationId,
        this.propertyOf(access),
        access.userId,
        meta,
        work,
      );
    } catch (error) {
      if (error instanceof AlreadyBilled) {
        throw new ApiError(
          409,
          'ALREADY_BILLED',
          'Some of these charges were billed at the same time by someone else; run billing again',
        );
      }
      throw error;
    }
  }
}

const overlapping = () =>
  new ApiError(
    409,
    'OVERLAPPING_CHARGE',
    'This unit (or the whole property) already has a recurring charge of this type for some of these months',
  );

function recipientsOf(target: BillTo): NewInvoice['recipients'] {
  return target.billTo === 'OWNERS'
    ? target.recipients.map((o) => ({
        personId: o.personId,
        fullName: o.fullName,
        share: { numerator: o.numerator, denominator: o.denominator },
      }))
    : target.recipients.map((t) => ({ personId: t.personId, fullName: t.fullName, share: null }));
}
