import { randomUUID } from 'node:crypto';
import type { SubscriptionDto, SupportAccessDto } from '@veyra/api-contracts';

/*
 * Plans and support access for the fake API (Phase 13). Follows the wire contracts and the main
 * rules (organisation admins see them; only REQUESTED can be approved or denied, only open
 * access revoked); the API's own tests prove the rest.
 */

interface Reply {
  status: number;
  body?: unknown;
}

const fail = (status: number, code: string): Reply => ({
  status,
  body: { error: { code, message: code, details: [] } },
});
const ok = (body: unknown, status = 200): Reply => ({ status, body });
const now = () => new Date().toISOString();

export class FakePlatform {
  subscriptions = new Map<string, SubscriptionDto>();
  support: (SupportAccessDto & { organisationId: string })[] = [];

  subscriptionOf(organisationId: string): SubscriptionDto {
    let s = this.subscriptions.get(organisationId);
    if (!s) {
      s = {
        plan: {
          code: 'ENTERPRISE',
          name: 'Enterprise',
          features: [
            'visitors',
            'finance',
            'maintenance',
            'communications',
            'facilities',
            'workforce',
            'vendors',
            'incidents',
            'reporting',
            'governance',
            'integrations',
          ],
          maxProperties: null,
          maxUnits: null,
        },
        status: 'TRIAL',
        trialEndsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
        lapsed: false,
        usage: { properties: 1, units: 2 },
        history: [
          {
            fromPlan: null,
            toPlan: 'ENTERPRISE',
            fromStatus: null,
            toStatus: 'TRIAL',
            reason: null,
            createdAt: now(),
          },
        ],
      };
      this.subscriptions.set(organisationId, s);
    }
    return s;
  }

  /** As a platform administrator would (the admin tool is not under test here). */
  askForSupport(organisation: { id: string; name: string }, reason: string, hours: number) {
    const r = {
      id: randomUUID(),
      organisationId: organisation.id,
      organisation: { id: organisation.id, name: organisation.name },
      reason,
      hours,
      status: 'REQUESTED' as const,
      active: false,
      requestedBy: { name: 'Sam from VEYRA', email: 'sam@veyra.example.test' },
      decidedBy: null,
      decidedAt: null,
      startsAt: null,
      endsAt: null,
      revokedAt: null,
      createdAt: now(),
    };
    this.support.push(r);
    return r;
  }

  handleOrganisation(c: {
    method: string;
    sub: string;
    organisationId: string;
    permissions: string[];
    user: { displayName: string };
  }): Reply | null {
    const can = (p: string) => c.permissions.includes(p);
    if (c.sub === '/subscription' && c.method === 'GET') {
      return can('organisation.member.read')
        ? ok(this.subscriptionOf(c.organisationId))
        : fail(403, 'FORBIDDEN');
    }
    if (!c.sub.startsWith('/support-access')) return null;
    if (!can('organisation.member.read')) return fail(403, 'FORBIDDEN');
    const mine = this.support.filter((s) => s.organisationId === c.organisationId);
    const strip = ({ organisationId: _o, ...s }: (typeof mine)[number]) => s;
    if (c.sub === '/support-access' && c.method === 'GET') return ok({ data: mine.map(strip) });
    const m = /^\/support-access\/([^/]+)\/(approve|deny|revoke)$/.exec(c.sub);
    const r = m ? mine.find((s) => s.id === m[1]) : undefined;
    if (!m || !r) return fail(404, 'NOT_FOUND');
    if (!can('organisation.member.manage')) return fail(403, 'FORBIDDEN');
    if (m[2] === 'revoke') {
      if (!r.active) return fail(409, 'INVALID_STATE_TRANSITION');
      Object.assign(r, { status: 'REVOKED', active: false, revokedAt: now(), endsAt: now() });
    } else {
      if (r.status !== 'REQUESTED') return fail(409, 'INVALID_STATE_TRANSITION');
      const approved = m[2] === 'approve';
      Object.assign(r, {
        status: approved ? 'APPROVED' : 'DENIED',
        active: approved,
        decidedBy: c.user.displayName,
        decidedAt: now(),
        startsAt: approved ? now() : null,
        endsAt: approved ? new Date(Date.now() + r.hours * 3_600_000).toISOString() : null,
      });
    }
    return ok(strip(r));
  }
}
