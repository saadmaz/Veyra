import { randomUUID } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import type { InvitationDto, MembershipDto, OrganisationDto } from '@veyra/api-contracts';

/**
 * In-memory stand-in for the VEYRA API, answering the console's browser requests through
 * Playwright request interception. It follows the wire contracts in @veyra/api-contracts and the
 * API's error codes; the API's own behaviour is proven by its integration tests against a real
 * database. This keeps browser tests fast and deterministic, with no database or Redis.
 */

export const API = 'http://localhost:4000/api/v1';
const ORIGIN = 'http://localhost:3000';

interface FakeUser {
  id: string;
  email: string;
  password: string;
  displayName: string;
}

interface FakeMembership {
  id: string;
  organisationId: string;
  userId: string;
  role: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
}

interface FakeInvitation {
  id: string;
  organisationId: string;
  email: string;
  role: string;
  token: string;
  status: InvitationDto['status'];
}

const PERMISSIONS: Record<string, string[]> = {
  ORGANISATION_ADMIN: [
    'organisation.member.invite',
    'organisation.member.manage',
    'organisation.member.read',
    'organisation.profile.read',
    'organisation.settings.manage',
  ],
  FINANCE_OFFICER: ['organisation.profile.read'],
};

export class FakeApi {
  users: FakeUser[] = [];
  organisations: OrganisationDto[] = [];
  memberships: FakeMembership[] = [];
  invitations: FakeInvitation[] = [];
  currentUserId: string | null = null;
  /** When true, every request fails at the network level. */
  offline = false;
  /** Requests received, for assertions (method + path). */
  log: string[] = [];

  addUser(email: string, password: string, displayName: string): FakeUser {
    const user = { id: randomUUID(), email, password, displayName };
    this.users.push(user);
    return user;
  }

  addOrganisation(name: string, adminId: string): OrganisationDto {
    const organisation: OrganisationDto = {
      id: randomUUID(),
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      countryCode: 'PK',
      defaultCurrency: 'PKR',
      defaultTimeZone: 'Asia/Karachi',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
    };
    this.organisations.push(organisation);
    this.addMembership(organisation.id, adminId, 'ORGANISATION_ADMIN');
    return organisation;
  }

  addMembership(organisationId: string, userId: string, role: string) {
    this.memberships.push({ id: randomUUID(), organisationId, userId, role, status: 'ACTIVE' });
  }

  async install(page: Page): Promise<void> {
    await page.route(`${API}/**`, (route) => this.handle(route));
  }

  private get currentUser(): FakeUser | undefined {
    return this.users.find((u) => u.id === this.currentUserId);
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    if (this.offline) return route.abort('connectionrefused');
    if (method === 'OPTIONS') return this.reply(route, 204);
    this.log.push(`${method} ${path}`);
    const body = (request.postDataJSON() ?? {}) as Record<string, string>;

    // ------------------------------------------------------------- authentication
    if (method === 'POST' && path === '/auth/sign-up') {
      if (this.users.some((u) => u.email === body.email)) {
        return this.error(route, 409, 'EMAIL_ALREADY_REGISTERED');
      }
      if ((body.password ?? '').length < 12) {
        return this.error(route, 400, 'VALIDATION_FAILED', [
          { path: 'password', message: 'Password must be at least 12 characters' },
        ]);
      }
      const user = this.addUser(body.email ?? '', body.password ?? '', body.displayName ?? '');
      this.currentUserId = user.id;
      return this.reply(route, 201, this.authResponse(user));
    }
    if (method === 'POST' && path === '/auth/sign-in') {
      const user = this.users.find((u) => u.email === body.email && u.password === body.password);
      if (!user) return this.error(route, 401, 'INVALID_CREDENTIALS');
      this.currentUserId = user.id;
      return this.reply(route, 200, this.authResponse(user));
    }

    const user = this.currentUser;
    if (!user) return this.error(route, 401, 'UNAUTHENTICATED');

    if (method === 'GET' && path === '/auth/session') {
      return this.reply(route, 200, {
        user: { id: user.id, email: user.email, displayName: user.displayName },
        session: { client: 'web' },
      });
    }
    if (method === 'POST' && path === '/auth/sign-out') {
      this.currentUserId = null;
      return this.reply(route, 204);
    }

    // ------------------------------------------------------------- organisations
    if (path === '/organisations') {
      if (method === 'GET') {
        const data = this.organisations
          .map((organisation) => ({ organisation, roles: this.roles(organisation.id, user.id) }))
          .filter((row) => row.roles.length > 0);
        return this.reply(route, 200, { data });
      }
      if (this.organisations.some((o) => o.slug === body.slug)) {
        return this.error(route, 409, 'SLUG_TAKEN');
      }
      const organisation = this.addOrganisation(body.name ?? '', user.id);
      organisation.slug = body.slug ?? organisation.slug;
      organisation.defaultTimeZone = body.defaultTimeZone ?? organisation.defaultTimeZone;
      return this.reply(route, 201, organisation);
    }

    if (method === 'POST' && path === '/invitations/accept') {
      const invitation = this.invitations.find((i) => i.token === body.token);
      if (!invitation) return this.error(route, 404, 'INVITATION_NOT_FOUND');
      if (invitation.status !== 'PENDING') return this.error(route, 409, 'INVITATION_ALREADY_USED');
      if (invitation.email !== user.email)
        return this.error(route, 403, 'INVITATION_EMAIL_MISMATCH');
      invitation.status = 'ACCEPTED';
      this.addMembership(invitation.organisationId, user.id, invitation.role);
      const organisation = this.organisations.find((o) => o.id === invitation.organisationId);
      return this.reply(route, 200, { organisation, role: invitation.role });
    }

    const match = /^\/organisations\/([^/]+)(\/.*)?$/.exec(path);
    if (!match) return this.error(route, 404, 'NOT_FOUND');
    const organisation = this.organisations.find((o) => o.id === match[1]);
    const permissions = organisation
      ? [
          ...new Set(this.roles(organisation.id, user.id).flatMap((r) => PERMISSIONS[r] ?? [])),
        ].sort()
      : [];
    if (!organisation || permissions.length === 0) return this.error(route, 404, 'NOT_FOUND');
    const can = (permission: string) => permissions.includes(permission);
    const rest = match[2] ?? '';

    if (rest === '' && method === 'GET')
      return this.reply(route, 200, { ...organisation, permissions });
    if (rest === '/memberships' && method === 'GET') {
      if (!can('organisation.member.read')) return this.error(route, 403, 'FORBIDDEN');
      const data: MembershipDto[] = this.memberships
        .filter((m) => m.organisationId === organisation.id)
        .map((m) => {
          const member = this.users.find((u) => u.id === m.userId) as FakeUser;
          return {
            id: m.id,
            userId: m.userId,
            email: member.email,
            displayName: member.displayName,
            role: m.role,
            scopeType: 'ORGANISATION',
            scopeId: organisation.id,
            status: m.status,
            validFrom: organisation.createdAt,
            validUntil: null,
          };
        });
      return this.reply(route, 200, { data, nextCursor: null });
    }
    if (rest === '/invitations') {
      if (!can('organisation.member.invite')) return this.error(route, 403, 'FORBIDDEN');
      if (method === 'GET') {
        const data = this.invitations
          .filter((i) => i.organisationId === organisation.id)
          .map((i) => this.invitationDto(i));
        return this.reply(route, 200, { data, nextCursor: null });
      }
      const invitation: FakeInvitation = {
        id: randomUUID(),
        organisationId: organisation.id,
        email: (body.email ?? '').toLowerCase(),
        role: body.role ?? 'FINANCE_OFFICER',
        // 43 base64url characters, like the real token.
        token: Buffer.from(randomUUID() + randomUUID())
          .toString('base64url')
          .slice(0, 43),
        status: 'PENDING',
      };
      this.invitations.push(invitation);
      return this.reply(route, 201, {
        invitation: this.invitationDto(invitation),
        token: invitation.token,
      });
    }
    const revoke = /^\/invitations\/([^/]+)\/revoke$/.exec(rest);
    if (revoke && method === 'POST') {
      const invitation = this.invitations.find((i) => i.id === revoke[1]);
      if (invitation) invitation.status = 'REVOKED';
      return this.reply(route, 204);
    }
    return this.error(route, 404, 'NOT_FOUND');
  }

  private roles(organisationId: string, userId: string): string[] {
    return this.memberships
      .filter(
        (m) => m.organisationId === organisationId && m.userId === userId && m.status === 'ACTIVE',
      )
      .map((m) => m.role);
  }

  private invitationDto(i: FakeInvitation): InvitationDto {
    return {
      id: i.id,
      email: i.email,
      role: i.role,
      status: i.status,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      createdAt: new Date().toISOString(),
    };
  }

  private authResponse(user: FakeUser) {
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      session: {
        client: 'web',
        idleExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
    };
  }

  private reply(route: Route, status: number, body?: unknown) {
    return route.fulfill({
      status,
      headers: {
        'Access-Control-Allow-Origin': ORIGIN,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? '' : JSON.stringify(body),
    });
  }

  private error(
    route: Route,
    status: number,
    code: string,
    details?: { path: string; message: string }[],
  ) {
    return this.reply(route, status, {
      error: { code, message: code, ...(details ? { details } : {}), requestId: 'e2e' },
    });
  }
}
