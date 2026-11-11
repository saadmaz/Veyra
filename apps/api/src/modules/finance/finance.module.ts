import { Module } from '@nestjs/common';
import { API_ENV, type ApiEnv } from '../../platform/config/env';
import { AccessControlModule } from '../access-control/access-control.module';
import { FinanceService } from './application/finance.service';
import { FINANCE_REPOSITORY } from './application/finance-ports';
import { PAYMENT_GATEWAYS, type PaymentGateway } from './application/payment-gateway';
import { PaymentsService } from './application/payments.service';
import { PrismaFinanceRepository } from './infrastructure/prisma-finance.repository';
import { SandboxPaymentGateway } from './infrastructure/sandbox-payment-gateway';
import { FinanceController } from './presentation/finance.controller';
import { PaymentCallbacksController, PaymentsController } from './presentation/payments.controller';

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
 * recurring charges, billing runs, invoices, payments, allocations and online payments. Owns
 * the ledger, billing and payment tables.
 */
@Module({
  imports: [AccessControlModule],
  controllers: [FinanceController, PaymentsController, PaymentCallbacksController],
  providers: [
    FinanceService,
    PaymentsService,
    { provide: FINANCE_REPOSITORY, useClass: PrismaFinanceRepository },
    { provide: PAYMENT_GATEWAYS, useFactory: paymentGateways, inject: [API_ENV] },
  ],
})
export class FinanceModule {}
