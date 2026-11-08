import { Inject, Injectable } from '@nestjs/common';

export interface HealthCheck {
  readonly name: string;
  /** Resolves when the dependency is usable; rejects otherwise. */
  check(): Promise<void>;
}

export const HEALTH_CHECKS = Symbol('HEALTH_CHECKS');

export type CheckStatus = 'up' | 'down';

export interface ReadinessReport {
  status: 'ok' | 'error';
  checks: Record<string, CheckStatus>;
}

const CHECK_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  constructor(@Inject(HEALTH_CHECKS) private readonly checks: HealthCheck[]) {}

  /** Runs all dependency checks in parallel, each bounded by a timeout. */
  async readiness(): Promise<ReadinessReport> {
    const results = await Promise.all(
      this.checks.map(async (c) => [c.name, await this.run(c)] as const),
    );
    const checks = Object.fromEntries(results);
    const status = results.every(([, s]) => s === 'up') ? 'ok' : 'error';
    return { status, checks };
  }

  private async run(check: HealthCheck): Promise<CheckStatus> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
    });
    try {
      await Promise.race([check.check(), timeout]);
      return 'up';
    } catch {
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
