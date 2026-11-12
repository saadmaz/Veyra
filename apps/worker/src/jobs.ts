import type { DbClient } from '@veyra/db';
import { JobRouter } from './job-router';
import { checkSlaBreach, SLA_CHECK_JOB, SLA_DUE_EVENT } from './maintenance-jobs';
import {
  DELIVER_JOB,
  DELIVERY_DUE_EVENT,
  deliverNotification,
  type EmailSender,
  LogEmailSender,
  prismaDeliveryStore,
} from './notification-jobs';
import type { OutboxRoutes } from './outbox-relay';

export const SYSTEM_QUEUE = 'system';

/** Outbox event types relayed to jobs, and the job each becomes. */
export const OUTBOX_ROUTES: OutboxRoutes = {
  [SLA_DUE_EVENT]: SLA_CHECK_JOB,
  [DELIVERY_DUE_EVENT]: DELIVER_JOB,
};

/**
 * Registers all job handlers. Business modules add their handlers here; jobs that touch tenant
 * data get the database and run inside the tenant's row-level security context.
 */
export function createJobRouter(deps: { db?: DbClient; email?: EmailSender } = {}): JobRouter {
  const router = new JobRouter().register<{ sentAt: string }>('system.ping', {
    platform: true,
    handle: async (envelope) => ({ pong: true, sentAt: envelope.payload.sentAt }),
  });
  if (deps.db) {
    router.register(SLA_CHECK_JOB, { platform: false, handle: checkSlaBreach(deps.db) });
    router.register(DELIVER_JOB, {
      platform: false,
      handle: deliverNotification(prismaDeliveryStore(deps.db), deps.email ?? new LogEmailSender()),
    });
  }
  return router;
}
