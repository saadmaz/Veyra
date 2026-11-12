/*
 * Full-stack smoke test (Phase 14 Part 4). Runs against infra/compose/full-stack.yml: the real
 * API, worker, console, PostgreSQL and Redis in production mode. Walks the first journey of a
 * customer (sign up, two-step sign-in, organisation, property, unit, dashboard) and checks the
 * console serves its pages with the security headers. Exits non-zero on the first failure.
 *
 *   bun infra/smoke/smoke.ts [apiBase] [consoleBase] [workerBase]
 */
import { base32Decode, stepAt, totpCode } from '../../apps/api/src/modules/identity/domain/totp';

const API = process.argv[2] ?? 'http://localhost:4000/api/v1';
const CONSOLE = process.argv[3] ?? 'http://localhost:3000';
const WORKER = process.argv[4] ?? 'http://localhost:4001';
const run = Math.random().toString(36).slice(2, 8);
let cookie = '';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Smoke test failed: ${message}`);
}

async function call<T>(method: string, path: string, body?: unknown, expected = [200, 201, 204]) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0] ?? '';
  const text = await res.text();
  check(
    expected.includes(res.status),
    `${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`,
  );
  return (text ? JSON.parse(text) : undefined) as T;
}

async function main() {
  check((await fetch(`${API}/health/ready`)).ok, 'API not ready');
  check((await fetch(`${WORKER}/health/ready`)).ok, 'worker not ready');

  const email = `smoke-${run}@example.test`;
  const signUp = await call<{ user: { emailVerified: boolean } }>('POST', '/auth/sign-up', {
    email,
    password: 'a long smoke test passphrase',
    displayName: 'Smoke Test',
  });
  check(signUp.user.emailVerified === false, 'new accounts start unverified');

  const org = await call<{ id: string }>('POST', '/organisations', {
    name: `Smoke ${run}`,
    slug: `smoke-${run}`,
    countryCode: 'PK',
    defaultCurrency: 'PKR',
    defaultTimeZone: 'Asia/Karachi',
  });
  const property = {
    name: 'Smoke Tower',
    code: 'SMK',
    type: 'CONDOMINIUM',
    addressLine1: '1 Road',
    city: 'Karachi',
  };
  // Production enforces two-step sign-in for organisation admins.
  const refused = await call<{ error: { code: string } }>(
    'POST',
    `/organisations/${org.id}/properties`,
    property,
    [403],
  );
  check(refused.error.code === 'MFA_SETUP_REQUIRED', 'privileged changes need two-step sign-in');
  const setup = await call<{ secret: string }>('POST', '/auth/mfa/setup');
  const code = totpCode(base32Decode(setup.secret), stepAt(new Date()));
  const confirmed = await call<{ recoveryCodes: string[] }>('POST', '/auth/mfa/confirm', { code });
  check(confirmed.recoveryCodes.length === 10, 'ten recovery codes');

  const created = await call<{ id: string }>(
    'POST',
    `/organisations/${org.id}/properties`,
    property,
  );
  await call('POST', `/organisations/${org.id}/properties/${created.id}/units`, {
    number: '101',
    type: 'APARTMENT',
  });
  const dashboard = await call<{ occupancy: { units: number } | null }>(
    'GET',
    `/organisations/${org.id}/properties/${created.id}/dashboard`,
  );
  check(dashboard.occupancy?.units === 1, 'the dashboard counts the unit');
  const plan = await call<{ plan: { code: string }; status: string }>(
    'GET',
    `/organisations/${org.id}/subscription`,
  );
  check(
    plan.plan.code === 'ENTERPRISE' && plan.status === 'TRIAL',
    'new organisations start a trial',
  );

  const page = await fetch(`${CONSOLE}/sign-in`);
  check(page.ok, `console sign-in page answered ${page.status}`);
  const csp = page.headers.get('content-security-policy') ?? '';
  check(csp.includes("frame-ancestors 'none'"), 'console sends its Content-Security-Policy');
  check(page.headers.get('x-content-type-options') === 'nosniff', 'console sends nosniff');

  console.log(`Smoke test passed (organisation ${org.id}).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
