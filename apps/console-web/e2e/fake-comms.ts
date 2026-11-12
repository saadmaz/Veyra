import { randomUUID } from 'node:crypto';
import type { AnnouncementDto, DocumentDto } from '@veyra/api-contracts';

/*
 * Communications for the fake API (Phase 10): announcements with inbox copies, an empty
 * notification feed, and documents. Follows the wire contracts and the main rules (audience at
 * publishing, acknowledgement only where asked, owners' documents for owners); the API's own tests
 * prove the rest.
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

type Announcement = AnnouncementDto & {
  copies: Map<string, { readAt: string | null; acknowledgedAt: string | null }>;
};
type Document = DocumentDto & { propertyId: string };

export class FakeComms {
  announcements: Announcement[] = [];
  documents: Document[] = [];

  addDocument(propertyId: string, title: string, audience: DocumentDto['audience']) {
    const d: Document = {
      id: randomUUID(),
      propertyId,
      title,
      description: null,
      category: 'RULES',
      audience,
      expiresOn: null,
      expiry: 'NONE',
      status: 'ACTIVE',
      archivedAt: null,
      createdAt: now(),
      current: {
        id: randomUUID(),
        versionNumber: 1,
        fileName: `${title}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: 2048,
        readyAt: now(),
      },
    };
    this.documents.push(d);
    return d;
  }

  private view(a: Announcement): AnnouncementDto {
    const { copies, ...rest } = a;
    const all = [...copies.values()];
    return {
      ...rest,
      delivery: {
        recipients: all.length,
        read: all.filter((c) => c.readAt).length,
        acknowledged: all.filter((c) => c.acknowledgedAt).length,
      },
    };
  }

  /** Organisation routes: the inbox and notifications. */
  handleOrganisation(c: { method: string; sub: string; user: { id: string } }): Reply | null {
    const { method, sub, user } = c;
    if (sub === '/notifications' && method === 'GET') return ok({ data: [], unread: 0 });
    if (sub === '/notifications/read-all' && method === 'POST') return ok({ marked: 0 });
    if (sub === '/inbox' && method === 'GET') {
      return ok({
        data: this.announcements
          .filter((a) => a.status === 'PUBLISHED' && a.copies.has(user.id))
          .map((a) => {
            const copy = a.copies.get(user.id) as {
              readAt: string | null;
              acknowledgedAt: string | null;
            };
            const { delivery: _d, createdBy: _c, ...announcement } = this.view(a);
            return { announcement, ...copy };
          }),
      });
    }
    const m = /^\/inbox\/([^/]+)\/(read|acknowledge)$/.exec(sub);
    if (m && method === 'POST') {
      const a = this.announcements.find((x) => x.id === m[1] && x.status === 'PUBLISHED');
      const copy = a?.copies.get(user.id);
      if (!a || !copy) return fail(404, 'NOT_FOUND');
      if (m[2] === 'acknowledge' && !a.requiresAcknowledgement)
        return fail(409, 'INVALID_STATE_TRANSITION');
      copy.readAt ??= now();
      if (m[2] === 'acknowledge') copy.acknowledgedAt ??= now();
      return ok(copy);
    }
    return null;
  }

  /** Property routes: announcements, deliveries and documents. */
  handleProperty(c: {
    method: string;
    sub: string;
    body: Record<string, unknown>;
    property: { id: string; name: string };
    user: { id: string; displayName: string };
    permissions: string[];
    residents: () => string[];
    staff: () => string[];
  }): Reply | null {
    const { method, sub, body, property, user, permissions } = c;
    const can = (p: string) => permissions.includes(p);
    if (sub.startsWith('/notification-deliveries')) {
      return can('property.announcement.read') ? ok({ data: [] }) : fail(403, 'FORBIDDEN');
    }
    if (sub.startsWith('/announcements')) {
      if (!can('property.announcement.read')) return fail(403, 'FORBIDDEN');
      const mine = this.announcements.filter((a) => a.property.id === property.id);
      if (sub === '/announcements' && method === 'GET')
        return ok({ data: mine.map((a) => this.view(a)) });
      if (!can('property.announcement.manage')) return fail(403, 'FORBIDDEN');
      if (sub === '/announcements' && method === 'POST') {
        const a: Announcement = {
          id: randomUUID(),
          property: { id: property.id, name: property.name },
          title: String(body.title),
          body: String(body.body),
          priority: body.priority === 'URGENT' ? 'URGENT' : 'NORMAL',
          audience: body.audience as AnnouncementDto['audience'],
          building: null,
          requiresAcknowledgement: Boolean(body.requiresAcknowledgement),
          status: 'DRAFT',
          publishedAt: null,
          publishedBy: null,
          withdrawnAt: null,
          withdrawReason: null,
          createdBy: user.displayName,
          createdAt: now(),
          delivery: { recipients: 0, read: 0, acknowledged: 0 },
          copies: new Map(),
        };
        this.announcements.push(a);
        return ok({ announcement: this.view(a), recipients: [] }, 201);
      }
      const m = /^\/announcements\/([^/]+)\/(publish|withdraw)$/.exec(sub);
      const a = m ? mine.find((x) => x.id === m[1]) : undefined;
      if (!m || !a) return fail(404, 'NOT_FOUND');
      if (m[2] === 'publish') {
        const people = new Set<string>();
        if (a.audience !== 'STAFF') for (const r of c.residents()) people.add(r);
        if (a.audience === 'EVERYONE' || a.audience === 'STAFF')
          for (const s of c.staff()) people.add(s);
        for (const p of people) a.copies.set(p, { readAt: null, acknowledgedAt: null });
        a.status = 'PUBLISHED';
        a.publishedAt = now();
        a.publishedBy = user.displayName;
      } else {
        a.status = 'WITHDRAWN';
        a.withdrawnAt = now();
        a.withdrawReason = String(body.reason);
      }
      return ok({ announcement: this.view(a), recipients: [] });
    }
    if (sub.startsWith('/documents')) {
      if (!can('property.document.read')) return fail(403, 'FORBIDDEN');
      const mine = this.documents.filter((d) => d.propertyId === property.id);
      if (sub === '/documents' && method === 'GET') return ok({ data: mine });
      return fail(404, 'NOT_FOUND');
    }
    return null;
  }

  /** A unit's documents for its residents. */
  handleUnit(c: { method: string; sub: string; propertyId: string; owner: boolean }): Reply | null {
    if (!c.sub.startsWith('/documents')) return null;
    const audiences = c.owner ? ['EVERYONE', 'RESIDENTS', 'OWNERS'] : ['EVERYONE', 'RESIDENTS'];
    const visible = this.documents.filter(
      (d) => d.propertyId === c.propertyId && audiences.includes(d.audience),
    );
    if (c.sub === '/documents' && c.method === 'GET') return ok({ data: visible });
    const m = /^\/documents\/([^/]+)\/download$/.exec(c.sub);
    const d = m ? visible.find((x) => x.id === m[1]) : undefined;
    if (!d) return fail(404, 'NOT_FOUND');
    return ok({ url: `https://storage.example.test/${d.id}`, expiresAt: now() });
  }
}
