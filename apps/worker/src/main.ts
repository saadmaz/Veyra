import { createServer } from 'node:http';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadWorkerEnv } from './env';
import { createJobRouter, SYSTEM_QUEUE } from './jobs';

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const router = createJobRouter();

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
    await worker.close();
    await connection.quit();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
