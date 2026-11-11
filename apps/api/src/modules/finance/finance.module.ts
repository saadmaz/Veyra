import { Module } from '@nestjs/common';
import { API_ENV, type ApiEnv } from '../../platform/config/env';
import { AccessControlModule } from '../access-control/access-control.module';
import { ControlsService } from './application/controls.service';
import { FinanceService } from './application/finance.service';
import { FINANCE_REPOSITORY } from './application/finance-ports';
import { PAYMENT_GATEWAYS, type PaymentGateway } from './application/payment-gateway';
import { PaymentsService } from './application/payments.service';
import { ResidentFinanceService } from './application/resident-finance.service';
import { PrismaFinanceRepository } from './infrastructure/prisma-finance.repository';
import { SandboxPaymentGateway } from './infrastructure/sandbox-payment-gateway';
import { ControlsController } from './presentation/controls.controller';
import { FinanceController } from './presentation/finance.controller';
import { PaymentCallbacksController, PaymentsController } from './presentation/payments.controller';
import { ResidentFinanceController } from './presentation/resident-finance.controller';

/** The gateway adapters this deployment enables. No real provider yet (Phase 6 decision). */
function paymentGateways(env: ApiEnv): ReadonlyMap<string, PaymentGateway> {
  const gateways = new Map<string, PaymentGateway>();
  if (env.PAYMENT_SANDBOX_SECRET && env.NODE_ENV !== 'production') {
    const sandbox = new SandboxPaymentGateway(env.PAYMENT_SANDBOX_SECRET);
    gateways.set(sandbox.key, sandbox);
  }
  return gateways;
}

/**
 * Finance and billing (Phase 6): the property ledger's chart of accounts, charge types,
 * recurring charges, billing runs, invoices, payments, allocations and online payments, and
 * residents' own view of their account with bank-transfer submissions. Owns the ledger, billing,
 * payment and bank-transfer tables.
 */
@Module({
  imports: [AccessControlModule],
  controllers: [
    FinanceController,
    PaymentsController,
    PaymentCallbacksController,
    ControlsController,
    ResidentFinanceController,
  ],
  providers: [
    FinanceService,
    PaymentsService,
    ControlsService,
    ResidentFinanceService,
    { provide: FINANCE_REPOSITORY, useClass: PrismaFinanceRepository },
    { provide: PAYMENT_GATEWAYS, useFactory: paymentGateways, inject: [API_ENV] },
  ],
})
export class FinanceModule {}
