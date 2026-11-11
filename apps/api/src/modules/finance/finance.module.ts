import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { FinanceService } from './application/finance.service';
import { FINANCE_REPOSITORY } from './application/finance-ports';
import { PrismaFinanceRepository } from './infrastructure/prisma-finance.repository';
import { FinanceController } from './presentation/finance.controller';

/**
 * Finance and billing (Phase 6): the property ledger's chart of accounts, charge types,
 * recurring charges, billing runs and invoices. Owns ledger_accounts, accounting_periods,
 * journal_entries, journal_lines, charge_types, recurring_charges and the invoice tables.
 */
@Module({
  imports: [AccessControlModule],
  controllers: [FinanceController],
  providers: [FinanceService, { provide: FINANCE_REPOSITORY, useClass: PrismaFinanceRepository }],
})
export class FinanceModule {}
