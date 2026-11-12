import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { SUBSCRIPTION_READER, SubscriptionsService } from './application/subscriptions.service';
import { PrismaSubscriptionReader } from './infrastructure/prisma-subscription.reader';
import { SubscriptionsController } from './presentation/subscriptions.controller';

/** Subscriptions (Phase 13): plans and entitlements as an organisation sees them. */
@Module({
  imports: [AccessControlModule],
  controllers: [SubscriptionsController],
  providers: [
    SubscriptionsService,
    { provide: SUBSCRIPTION_READER, useClass: PrismaSubscriptionReader },
  ],
})
export class SubscriptionsModule {}
