import { createServer } from 'node:http';
import {
  claimOutboxEvents,
  createDbClient,
  markOutboxFailed,
  markOutboxPublished,
} from '@veyra/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadWorkerEnv } from './env';
import { createJobRouter, OUTBOX_ROUTES, SYSTEM_QUEUE } from './jobs';
import { OutboxRelay } from './outbox-relay';

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const db = createDbClient(env.DATABASE_URL);
  const router = createJobRouter({ db });

  // BullMQ workers require maxRetriesPerRequest: null for blocking commands.
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', (error: Error) => console.warn(`[worker] Redis error: ${error.message}`));

  const worker = new Worker(SYSTEM_QUEUE, (job) => router.dispatch(job.name, job.data), {
    connection,
    concurrency: env.WORKER_CONCURRENCY,
  });
  worker.on('failed', (job, error) =>
    console.error(`[worker] job ${job?.name} (${job?.id}) failed: ${error.message}`),
  );

  // Outbox relay (ARCHITECTURE section 5): due events become jobs, at least once.
  const queue = new Queue(SYSTEM_QUEUE, { connection });
  const relay = new OutboxRelay(
    {
      claim: (types, limit) => claimOutboxEvents(db, types, limit),
      published: (ids) => markOutboxPublished(db, ids),
      failed: (id, error) => markOutboxFailed(db, id, error),
    },
    async (name, envelope, jobId) => {
      await queue.add(name, envelope, {
        jobId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 1000,
        removeOnFail: false,
      });
    },
    OUTBOX_ROUTES,
  );
  let relaying = false;
  const relayTimer = setInterval(() => {
    if (relaying) return;
    relaying = true;
    relay
      .tick()
      .catch((error: unknown) =>
        console.error(
          `[worker] outbox relay failed: ${error instanceof Error ? error.message : error}`,
        ),
      )
      .finally(() => {
        relaying = false;
      });
  }, env.OUTBOX_POLL_MS);

  const health = createServer((req, res) => {
    if (req.url === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (req.url === '/health/ready') {
      const ready = connection.status === 'ready' && worker.isRunning();
      res
        .writeHead(ready ? 200 : 503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: ready ? 'ok' : 'error', redis: connection.status }));
      return;
    }
    res.writeHead(404).end();
  });
  health.listen(env.WORKER_HEALTH_PORT, () =>
    console.log(`[worker] health on port ${env.WORKER_HEALTH_PORT}, queue "${SYSTEM_QUEUE}"`),
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] ${signal} received, draining`);
    health.close();
    clearInterval(relayTimer);
    await worker.close();
    await queue.close();
    await connection.quit();
    await db.$disconnect();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
