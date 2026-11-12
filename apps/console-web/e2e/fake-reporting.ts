import { randomUUID } from 'node:crypto';
import type {
  ExportName,
  PropertyDashboardDto,
  WebhookDeliveryDto,
  WebhookEndpointDto,
} from '@veyra/api-contracts';

/*
 * Dashboards, exports and webhooks for the fake API (Phase 12). Follows the wire contracts and
 * the main rules (areas only with their read permission, exports with the export permission,
 * webhooks for organisation admins, secrets shown once); the API's own tests prove the rest.
 */

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const fail = (status: number, code: string): Reply => ({
  status,
  body: { error: { code, message: code, details: [] } },
});
const ok = (body: unknown, status = 200): Reply => ({ status, body });
const now = () => new Date().toISOString();

const AREAS: Record<ExportName, string> = {
  'occupancy-by-building': 'property.structure.read',
  arrears: 'property.finance.read',
  'maintenance-requests': 'property.maintenance.read',
  visits: 'property.visitor.read',
  incidents: 'property.incident.read',
};

export class FakeReporting {
  endpoints: (WebhookEndpointDto & { organisationId: string; deliveries: WebhookDeliveryDto[] })[] =
    [];
  /** Exports downloaded, as the API's audit log would record them. */
  exported: { report: string; userId: string }[] = [];

  handleProperty(c: {
    method: string;
    sub: string;
    property: { code: string; currency: string };
    user: { id: string };
    permissions: string[];
    units: number;
  }): Reply | null {
    const can = (p: string) => c.permissions.includes(p);
    if (c.sub === '/dashboard' && c.method === 'GET') {
      const money = (n: number) => ({ amountMinor: String(n), currency: c.property.currency });
      const body: PropertyDashboardDto = {
        asOf: now().slice(0, 10),
        occupancy: can('property.structure.read')
          ? { units: c.units, withOwner: 0, tenanted: 0 }
          : null,
        finance: can('property.finance.read')
          ? {
              outstanding: money(1250000),
              overdue: money(450000),
              overdueInvoices: 3,
              collectedLast30Days: money(2000000),
            }
          : null,
        maintenance: can('property.maintenance.read')
          ? { openRequests: 4, overdueRequests: 1, openWorkOrders: 2 }
          : null,
        visitors: can('property.visitor.read')
          ? { arrivedToday: 6, onSiteNow: 2, last7Days: 31 }
          : null,
        facilities: can('property.facility.read')
          ? { bookingsNext7Days: 5, awaitingApproval: 1 }
          : null,
        incidents: can('property.incident.read') ? { open: 1, openHighOrCritical: 0 } : null,
        pendingApprovals: can('property.approval.read') ? 2 : null,
      };
      return ok(body);
    }
    if (c.sub === '/exports' && c.method === 'GET') {
      const names = can('property.report.export')
        ? (Object.keys(AREAS) as ExportName[]).filter((n) => can(AREAS[n]))
        : [];
      return ok({ data: names });
    }
    const m = /^\/exports\/([a-z-]+)$/.exec(c.sub);
    if (m && c.method === 'GET') {
      const name = m[1] as ExportName;
      if (!(name in AREAS)) return fail(400, 'VALIDATION_FAILED');
      if (!can('property.report.export') || !can(AREAS[name])) return fail(403, 'FORBIDDEN');
      this.exported.push({ report: name, userId: c.user.id });
      return {
        status: 200,
        body: 'building,units,tenanted,with_owner,note\r\n(no building),2,,,too few units to show\r\n',
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${c.property.code}-${name}-${now().slice(0, 10)}.csv"`,
        },
      };
    }
    return null;
  }

  handleOrganisation(c: {
    method: string;
    sub: string;
    body: Record<string, unknown>;
    organisationId: string;
    permissions: string[];
  }): Reply | null {
    if (!c.sub.startsWith('/webhooks')) return null;
    if (!c.permissions.includes('organisation.webhook.manage')) return fail(403, 'FORBIDDEN');
    const mine = this.endpoints.filter((e) => e.organisationId === c.organisationId);
    const view = ({ organisationId: _o, deliveries: _d, ...e }: (typeof mine)[number]) => e;
    const secret = () => `whsec_${randomUUID().replaceAll('-', '')}`;
    if (c.sub === '/webhooks/events') {
      return ok({
        data: [
          'incident.reported',
          'incident.closed',
          'approval_request.created',
          'approval_request.settled',
        ],
      });
    }
    if (c.sub === '/webhooks' && c.method === 'GET') return ok({ data: mine.map(view) });
    if (c.sub === '/webhooks' && c.method === 'POST') {
      const url = String(c.body.url ?? '');
      const events = (c.body.events as string[]) ?? [];
      if (!url.startsWith('https://') || events.length === 0) {
        return {
          status: 400,
          body: {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Check the fields',
              details: [
                ...(url.startsWith('https://')
                  ? []
                  : [{ path: 'url', message: 'Webhooks are sent only over HTTPS' }]),
                ...(events.length ? [] : [{ path: 'events', message: 'Choose an event' }]),
              ],
            },
          },
        };
      }
      const e = {
        id: randomUUID(),
        organisationId: c.organisationId,
        url,
        description: (c.body.description as string | null) ?? null,
        events,
        status: 'ACTIVE' as const,
        createdAt: now(),
        deliveries: [],
      };
      this.endpoints.push(e);
      return ok({ endpoint: view(e), secret: secret() }, 201);
    }
    const m = /^\/webhooks\/([^/]+)(\/test|\/rotate-secret)?$/.exec(c.sub);
    const e = m ? mine.find((x) => x.id === m[1]) : undefined;
    if (!m || !e) return fail(404, 'NOT_FOUND');
    if (!m[2] && c.method === 'GET') return ok({ endpoint: view(e), deliveries: e.deliveries });
    if (!m[2] && c.method === 'PATCH') {
      Object.assign(e, c.body);
      return ok(view(e));
    }
    if (m[2] === '/rotate-secret') return ok({ endpoint: view(e), secret: secret() });
    if (e.status !== 'ACTIVE') return fail(409, 'INVALID_STATE_TRANSITION');
    e.deliveries.unshift({
      id: randomUUID(),
      eventType: 'webhook.test',
      eventId: randomUUID(),
      status: 'SUCCEEDED',
      attempts: 1,
      lastStatusCode: 200,
      lastError: null,
      deliveredAt: now(),
      createdAt: now(),
    });
    return ok({ endpoint: view(e), deliveries: e.deliveries });
  }
}
