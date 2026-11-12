import { randomUUID } from 'node:crypto';
import type {
  ApprovalRequestDto,
  CommitteeDto,
  EscalationContactDto,
  IncidentDto,
  IncidentUpdateDto,
  MeetingDto,
} from '@veyra/api-contracts';

/*
 * Incidents, committees and meetings, and approvals for the fake API (Phase 11). Follows the wire
 * contracts and the main rules (who may do what, the incident and meeting states, an outcome to
 * resolve, approvals settled at the required number); the API's own tests prove the rest.
 */

interface Reply {
  status: number;
  body?: unknown;
}

const fail = (status: number, code: string, message = code): Reply => ({
  status,
  body: { error: { code, message, details: [] } },
});
const ok = (body: unknown, status = 200): Reply => ({ status, body });
const now = () => new Date().toISOString();
const ref = (prefix: string, n: number) => `${prefix}-${String(n).padStart(6, '0')}`;

type Incident = IncidentDto & {
  propertyId: string;
  reporterId: string;
  updates: IncidentUpdateDto[];
};
type Meeting = MeetingDto & { propertyId: string };
type Request = Omit<ApprovalRequestDto, 'canDecide'> & {
  propertyId: string;
  deciders: string[];
};

interface Context {
  method: string;
  sub: string;
  body: Record<string, unknown>;
  property: { id: string; currency: string };
  user: { id: string; displayName: string };
  permissions: string[];
  /** Whether the list asked for settled or closed items too (?status=all). */
  all: boolean;
  /** People holding a property permission. */
  holders: (permission: string) => { userId: string; name: string }[];
}

export class FakeGovernance {
  incidents: Incident[] = [];
  contacts: (EscalationContactDto & { propertyId: string })[] = [];
  committees: (CommitteeDto & { propertyId: string })[] = [];
  meetings: Meeting[] = [];
  requests: Request[] = [];

  addContact(propertyId: string, name: string, role: string, phone: string) {
    this.contacts.push({
      id: randomUUID(),
      propertyId,
      name,
      role,
      phone,
      email: null,
      categories: [],
      position: this.contacts.length,
      active: true,
    });
  }

  addCommittee(propertyId: string, name: string, seats: { userId: string; name: string }[]) {
    const c = {
      id: randomUUID(),
      propertyId,
      name,
      purpose: null,
      status: 'ACTIVE' as const,
      dissolvedAt: null,
      createdAt: now(),
      seats: seats.map((s, i) => ({
        id: randomUUID(),
        userId: s.userId,
        name: s.name,
        position: i === 0 ? ('CHAIR' as const) : ('MEMBER' as const),
        termStart: '2026-01-01',
        termEnd: null,
        current: true,
      })),
    };
    this.committees.push(c);
    return c;
  }

  handleProperty(c: Context): Reply | null {
    const { sub } = c;
    if (sub.startsWith('/incidents') || sub.startsWith('/escalation-contacts'))
      return this.incident(c);
    if (sub.startsWith('/committees') || sub.startsWith('/meetings')) return this.governance(c);
    if (sub.startsWith('/approval-requests') || sub.startsWith('/approval-policies')) {
      return this.approval(c);
    }
    return null;
  }

  private incident(c: Context): Reply {
    const { method, sub, body, property, user } = c;
    const can = (p: string) => c.permissions.includes(p);
    if (!can('property.incident.read')) return fail(403, 'FORBIDDEN');
    const manager = can('property.incident.manage');
    const contacts = this.contacts.filter((x) => x.propertyId === property.id && x.active);
    if (sub.startsWith('/escalation-contacts')) {
      return method === 'GET' ? ok({ data: contacts }) : fail(403, 'FORBIDDEN');
    }
    const visible = this.incidents.filter(
      (i) => i.propertyId === property.id && (manager || !i.sensitive || i.reporterId === user.id),
    );
    const view = (i: Incident) => {
      const { propertyId: _p, reporterId: _r, updates, ...incident } = i;
      return { incident, updates, actions: [], contacts };
    };
    if (sub.startsWith('/incidents?') || sub === '/incidents') {
      if (method === 'GET') {
        const all = c.all;
        return ok({
          data: visible.filter((i) => all || i.status !== 'CLOSED').map((i) => view(i).incident),
        });
      }
      if (!can('property.incident.report')) return fail(403, 'FORBIDDEN');
      const i: Incident = {
        id: randomUUID(),
        propertyId: property.id,
        reporterId: user.id,
        reference: ref('IN', this.incidents.length + 1),
        category: body.category as IncidentDto['category'],
        severity: body.severity as IncidentDto['severity'],
        title: String(body.title),
        description: String(body.description),
        occurredAt: String(body.occurredAt),
        unit: null,
        commonArea: null,
        locationDetail: (body.locationDetail as string | null) ?? null,
        sensitive: Boolean(body.sensitive),
        status: 'OPEN',
        outcome: null,
        reportedBy: user.displayName,
        resolvedAt: null,
        closedAt: null,
        createdAt: now(),
        openActions: 0,
        updates: [],
      };
      i.updates.push(this.log(i, null, 'OPEN', null, user.displayName));
      this.incidents.push(i);
      return ok(view(i), 201);
    }
    if (sub === '/incidents/assignees') return ok({ data: c.holders('property.incident.read') });
    const m = /^\/incidents\/([^/]+)(\/status|\/notes)?$/.exec(sub);
    const i = m ? visible.find((x) => x.id === m[1]) : undefined;
    if (!m || !i) return fail(404, 'NOT_FOUND');
    if (!m[2] && method === 'GET') return ok(view(i));
    if (m[2] === '/notes') {
      if (i.status === 'CLOSED') return fail(409, 'INVALID_STATE_TRANSITION');
      i.updates.push({
        ...this.log(i, null, null, String(body.body), user.displayName),
        kind: 'NOTE',
      });
      return ok(view(i));
    }
    if (!manager) return fail(403, 'FORBIDDEN');
    if (!m[2] && method === 'PATCH') {
      Object.assign(i, body);
      return ok(view(i));
    }
    const to = body.status as IncidentDto['status'];
    const moves: Record<string, string[]> = {
      OPEN: ['RESPONDING', 'RESOLVED'],
      RESPONDING: ['RESOLVED'],
      RESOLVED: ['RESPONDING', 'CLOSED'],
      CLOSED: [],
    };
    if (!moves[i.status]?.includes(to)) return fail(409, 'INVALID_STATE_TRANSITION');
    if (to === 'RESOLVED' && !body.outcome) {
      return {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Say how the incident ended',
            details: [{ path: 'outcome', message: 'Say how the incident ended' }],
          },
        },
      };
    }
    const from = i.status;
    i.status = to;
    if (to === 'RESOLVED') {
      i.outcome = String(body.outcome);
      i.resolvedAt = now();
    }
    if (to === 'RESPONDING') i.outcome = null;
    if (to === 'CLOSED') i.closedAt = now();
    i.updates.push(this.log(i, from, to, to === 'RESOLVED' ? i.outcome : null, user.displayName));
    return ok(view(i));
  }

  private log(
    i: Incident,
    from: IncidentDto['status'] | null,
    to: IncidentDto['status'] | null,
    text: string | null,
    actor: string,
  ): IncidentUpdateDto {
    return {
      id: randomUUID(),
      kind: 'STATUS_CHANGED',
      fromStatus: from,
      toStatus: to,
      body: text,
      actor,
      createdAt: new Date(Date.now() + i.updates.length).toISOString(),
    };
  }

  private governance(c: Context): Reply {
    const { method, sub, body, property, user } = c;
    const can = (p: string) => c.permissions.includes(p);
    if (!can('property.governance.read')) return fail(403, 'FORBIDDEN');
    const committees = this.committees.filter((x) => x.propertyId === property.id);
    const strip = <T extends { propertyId: string }>({ propertyId: _p, ...rest }: T) => rest;
    if (sub === '/committees' && method === 'GET') return ok({ data: committees.map(strip) });
    if (sub === '/committees/candidates') {
      return can('property.governance.manage')
        ? ok({ data: c.holders('property.governance.read') })
        : fail(403, 'FORBIDDEN');
    }
    const meetings = this.meetings.filter((x) => x.propertyId === property.id);
    if (sub.startsWith('/meetings') && method === 'GET' && !sub.slice(1).includes('/')) {
      return ok({ data: meetings.map(strip) });
    }
    if (!can('property.governance.manage') && method !== 'GET') return fail(403, 'FORBIDDEN');
    const sched = /^\/committees\/([^/]+)\/meetings$/.exec(sub);
    if (sched && method === 'POST') {
      const committee = committees.find((x) => x.id === sched[1]);
      if (!committee) return fail(404, 'NOT_FOUND');
      const m: Meeting = {
        id: randomUUID(),
        propertyId: property.id,
        committee: { id: committee.id, name: committee.name },
        title: String(body.title),
        scheduledAt: String(body.scheduledAt),
        location: (body.location as string | null) ?? null,
        status: 'SCHEDULED',
        heldAt: null,
        cancelReason: null,
        minutes: null,
        minutesApprovedAt: null,
        minutesApprovedBy: null,
        agenda: ((body.agenda as { title: string }[]) ?? []).map((a, n) => ({
          id: randomUUID(),
          position: n + 1,
          title: a.title,
          details: null,
        })),
        resolutions: [],
      };
      this.meetings.push(m);
      return ok(strip(m), 201);
    }
    const mm = /^\/meetings\/([^/]+)(\/[a-z/]+)?$/.exec(sub);
    const m = mm ? meetings.find((x) => x.id === mm[1]) : undefined;
    if (!mm || !m) return fail(404, 'NOT_FOUND');
    const action = mm[2] ?? '';
    const held = m.status === 'HELD' && !m.minutesApprovedAt;
    if (!action && method === 'GET') return ok(strip(m));
    if (action === '/held' && m.status === 'SCHEDULED') {
      m.status = 'HELD';
      m.heldAt = now();
    } else if (action === '/minutes' && held) {
      m.minutes = String(body.minutes);
    } else if (action === '/minutes/approve' && held && m.minutes) {
      m.minutesApprovedAt = now();
      m.minutesApprovedBy = user.displayName;
    } else if (action === '/resolutions' && held) {
      m.resolutions.push({
        id: randomUUID(),
        reference: ref(
          'RES',
          this.meetings.reduce((n, x) => n + x.resolutions.length, 1),
        ),
        title: String(body.title),
        text: String(body.text),
        outcome: body.outcome as 'PASSED',
        votesFor: (body.votesFor as number | null) ?? null,
        votesAgainst: (body.votesAgainst as number | null) ?? null,
        abstentions: (body.abstentions as number | null) ?? null,
        document: null,
        recordedBy: user.displayName,
        createdAt: now(),
      });
      return ok(strip(m), 201);
    } else {
      return fail(409, 'INVALID_STATE_TRANSITION');
    }
    return ok(strip(m));
  }

  private approval(c: Context): Reply {
    const { method, sub, body, property, user } = c;
    const can = (p: string) => c.permissions.includes(p);
    if (!can('property.approval.read')) return fail(403, 'FORBIDDEN');
    if (sub.startsWith('/approval-policies')) {
      return method === 'GET' ? ok({ data: [] }) : fail(403, 'FORBIDDEN');
    }
    const mine = this.requests.filter((r) => r.propertyId === property.id);
    const view = (r: Request): ApprovalRequestDto => {
      const { propertyId: _p, deciders, ...rest } = r;
      const canDecide =
        r.status === 'PENDING' &&
        r.requestedBy.userId !== user.id &&
        !r.decisions.some((d) => d.name === user.displayName) &&
        deciders.includes(user.id);
      return { ...rest, canDecide };
    };
    if (sub.startsWith('/approval-requests?') || sub === '/approval-requests') {
      if (method === 'GET') {
        const all = c.all;
        return ok({ data: mine.filter((r) => all || r.status === 'PENDING').map(view) });
      }
      if (!can('property.approval.request')) return fail(403, 'FORBIDDEN');
      const amount = body.amount as string | null;
      const r: Request = {
        id: randomUUID(),
        propertyId: property.id,
        reference: ref('AR', this.requests.length + 1),
        requestType: body.requestType as Request['requestType'],
        title: String(body.title),
        description: String(body.description),
        amount: amount
          ? { amountMinor: String(Math.round(Number(amount) * 100)), currency: property.currency }
          : null,
        document: null,
        requiredApprovals: 1,
        approvers: 'MANAGERS',
        committee: null,
        status: 'PENDING',
        requestedBy: { userId: user.id, name: user.displayName },
        decidedAt: null,
        createdAt: now(),
        approvals: 0,
        decisions: [],
        deciders: c.holders('property.approval.decide').map((h) => h.userId),
      };
      this.requests.push(r);
      return ok(view(r), 201);
    }
    const m = /^\/approval-requests\/([^/]+)(\/decisions|\/withdraw)?$/.exec(sub);
    const r = m ? mine.find((x) => x.id === m[1]) : undefined;
    if (!m || !r) return fail(404, 'NOT_FOUND');
    if (!m[2]) return ok(view(r));
    if (m[2] === '/withdraw') {
      if (r.requestedBy.userId !== user.id) return fail(404, 'NOT_FOUND');
      r.status = 'WITHDRAWN';
      return ok(view(r));
    }
    if (!view(r).canDecide) return fail(403, 'NOT_AN_APPROVER');
    const decision = body.decision as 'APPROVE' | 'REJECT';
    r.decisions.push({
      name: user.displayName,
      decision,
      note: (body.note as string | null) ?? null,
      createdAt: now(),
    });
    if (decision === 'REJECT') r.status = 'REJECTED';
    else if (++r.approvals >= r.requiredApprovals) r.status = 'APPROVED';
    if (r.status !== 'PENDING') r.decidedAt = now();
    return ok(view(r), 201);
  }
}
