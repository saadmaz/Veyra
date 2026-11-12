import { Module } from '@nestjs/common';
import { parseWebhookKey } from '@veyra/db';
import { API_ENV, type ApiEnv } from '../../platform/config/env';
import { AccessControlModule } from '../access-control/access-control.module';
import { WEBHOOK_KEY, WEBHOOK_REPOSITORY } from './application/webhook-ports';
import { WebhooksService } from './application/webhooks.service';
import { PrismaWebhookRepository } from './infrastructure/prisma-webhook.repository';
import { WebhooksController } from './presentation/webhooks.controller';

/**
 * Integrations (Phase 12): outbound webhooks. Owns the webhook tables; other modules emit events
 * through WebhooksService on their own transaction. Inbound adapters come with their first need.
 */
@Module({
  imports: [AccessControlModule],
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    { provide: WEBHOOK_REPOSITORY, useClass: PrismaWebhookRepository },
    {
      provide: WEBHOOK_KEY,
      useFactory: (env: ApiEnv) =>
        env.WEBHOOK_SIGNING_KEY ? parseWebhookKey(env.WEBHOOK_SIGNING_KEY) : null,
      inject: [API_ENV],
    },
  ],
  exports: [WebhooksService],
})
export class IntegrationsModule {}
