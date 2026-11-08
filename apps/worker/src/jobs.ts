import { JobRouter } from './job-router';

export const SYSTEM_QUEUE = 'system';

/** Registers all job handlers. Business modules add their handlers here from Phase 2 onwards. */
export function createJobRouter(): JobRouter {
  return new JobRouter().register<{ sentAt: string }>('system.ping', {
    platform: true,
    handle: async (envelope) => ({ pong: true, sentAt: envelope.payload.sentAt }),
  });
}
