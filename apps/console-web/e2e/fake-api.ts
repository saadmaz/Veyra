import { randomUUID } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import type {
  BuildingDto,
  CommonAreaDto,
  FloorDto,
  InvitationDto,
  MembershipDto,
  OrganisationDto,
  PropertyDto,
  UnitDto,
} from '@veyra/api-contracts';

/**
 * In-memory stand-in for the VEYRA API, answering the console's browser requests through
 * Playwright request interception. It follows the wire contracts in @veyra/api-contracts and the
 * API's error codes and main rules (scopes, archive checks, duplicates); the API's own
 * behaviour is proven by its integration tests against a real database. This keeps browser
 * tests fast and deterministic, with no database or Redis.
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
  scopeType: 'ORGANISATION' | 'PROPERTY';
  scopeId: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
}

interface FakeInvitation {
  id: string;
  organisationId: string;
  email: string;
  role: string;
  token: string;
  status: InvitationDto['status'];
  propertyId?: string;
}

/** Mirrors apps/api access-control roles: permissions per evaluation scope. */
const ROLES: Record<string, { organisation: string[]; property: string[] }> = {
  ORGANISATION_ADMIN: {
    organisation: [
      'organisation.member.invite',
      'organisation.member.manage',
      'organisation.member.read',
      'organisation.profile.read',
      'organisation.property.create',
      'organisation.settings.manage',
    ],
    property: [
      'property.lifecycle.manage',
      'property.profile.read',
      'property.settings.manage',
      'property.structure.manage',
      'property.structure.read',
    ],
  },
  FINANCE_OFFICER: {
    organisation: ['organisation.profile.read'],
    property: ['property.profile.read', 'property.structure.read'],
  },
  PROPERTY_MANAGER: {
    organisation: [],
    property: [
      'property.profile.read',
      'property.settings.manage',
      'property.structure.manage',
      'property.structure.read',
    ],
  },
};

type Status = 'ACTIVE' | 'ARCHIVED';
const now = () => new Date().toISOString();

export class FakeApi {
  users: FakeUser[] = [];
  organisations: OrganisationDto[] = [];
  memberships: FakeMembership[] = [];
  invitations: FakeInvitation[] = [];
  properties: (PropertyDto & { organisationId: string })[] = [];
  buildings: BuildingDto[] = [];
  floors: FloorDto[] = [];
  units: UnitDto[] = [];
  commonAreas: CommonAreaDto[] = [];
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
      createdAt: now(),
    };
    this.organisations.push(organisation);
    this.addMembership(organisation.id, adminId, 'ORGANISATION_ADMIN');
    return organisation;
  }

  addMembership(organisationId: string, userId: string, role: string, propertyId?: string) {
    this.memberships.push({
      id: randomUUID(),
      organisationId,
      userId,
      role,
      scopeType: propertyId ? 'PROPERTY' : 'ORGANISATION',
      scopeId: propertyId ?? organisationId,
      status: 'ACTIVE',
    });
  }

  addProperty(organisationId: string, name: string, code: string): PropertyDto {
    const property = {
      id: randomUUID(),
      organisationId,
      name,
      code,
      type: 'CONDOMINIUM' as const,
      status: 'ONBOARDING' as const,
      addressLine1: '1 Shore Road',
      addressLine2: null,
      city: 'Karachi',
      region: null,
      postalCode: null,
      countryCode: 'PK',
      timeZone: 'Asia/Karachi',
      currency: 'PKR',
      createdAt: now(),
    };
    this.properties.push(property);
    return property;
  }

  async install(page: Page): Promise<void> {
    await page.route(`${API}/**`, (route) => this.handle(route));
  }

  private get currentUser(): FakeUser | undefined {
    return this.users.find((u) => u.id === this.currentUserId);
  }

  private grants(organisationId: string, userId: string) {
    return this.memberships.filter(
      (m) => m.organisationId === organisationId && m.userId === userId && m.status === 'ACTIVE',
    );
  }

  private organisationPermissions(organisationId: string, userId: string): string[] {
    const grants = this.grants(organisationId, userId);
    if (grants.length === 0) return [];
    const permissions = new Set(['organisation.profile.read']); // member baseline
    for (const g of grants) {
      if (g.scopeType === 'ORGANISATION')
        for (const p of ROLES[g.role]?.organisation ?? []) permissions.add(p);
    }
    return [...permissions].sort();
  }

  /** Grants covering the property: organisation-wide, or on that exact property. */
  private propertyPermissions(
    organisationId: string,
    propertyId: string,
    userId: string,
  ): string[] | null {
    const covering = this.grants(organisationId, userId).filter(
      (g) => g.scopeType === 'ORGANISATION' || g.scopeId === propertyId,
    );
    if (covering.length === 0) return null;
    const property = this.properties.find((p) => p.id === propertyId);
    const permissions = new Set(covering.flatMap((g) => ROLES[g.role]?.property ?? []));
    if (property?.status === 'ARCHIVED') {
      for (const p of permissions) if (!p.endsWith('.read')) permissions.delete(p);
    }
    return [...permissions].sort();
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    if (this.offline) return route.abort('connectionrefused');
    if (method === 'OPTIONS') return this.reply(route, 204);
    this.log.push(`${method} ${path}`);
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    const str = (key: string) =>
      typeof body[key] === 'string' ? (body[key] as string) : undefined;

    // ------------------------------------------------------------- authentication
    if (method === 'POST' && path === '/auth/sign-up') {
      if (this.users.some((u) => u.email === str('email'))) {
        return this.error(route, 409, 'EMAIL_ALREADY_REGISTERED');
      }
      if ((str('password') ?? '').length < 12) {
        return this.error(route, 400, 'VALIDATION_FAILED', [
          { path: 'password', message: 'Password must be at least 12 characters' },
        ]);
      }
      const user = this.addUser(
        str('email') ?? '',
        str('password') ?? '',
        str('displayName') ?? '',
      );
      this.currentUserId = user.id;
      return this.reply(route, 201, this.authResponse(user));
    }
    if (method === 'POST' && path === '/auth/sign-in') {
      const user = this.users.find(
        (u) => u.email === str('email') && u.password === str('password'),
      );
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
          .map((organisation) => ({
            organisation,
            roles: [...new Set(this.grants(organisation.id, user.id).map((g) => g.role))].sort(),
          }))
          .filter((row) => row.roles.length > 0);
        return this.reply(route, 200, { data });
      }
      if (this.organisations.some((o) => o.slug === str('slug')))
        return this.error(route, 409, 'SLUG_TAKEN');
      const organisation = this.addOrganisation(str('name') ?? '', user.id);
      organisation.slug = str('slug') ?? organisation.slug;
      organisation.defaultTimeZone = str('defaultTimeZone') ?? organisation.defaultTimeZone;
      return this.reply(route, 201, organisation);
    }

    if (method === 'POST' && path === '/invitations/accept') {
      const invitation = this.invitations.find((i) => i.token === str('token'));
      if (!invitation) return this.error(route, 404, 'INVITATION_NOT_FOUND');
      if (invitation.status !== 'PENDING') return this.error(route, 409, 'INVITATION_ALREADY_USED');
      if (invitation.email !== user.email)
        return this.error(route, 403, 'INVITATION_EMAIL_MISMATCH');
      invitation.status = 'ACCEPTED';
      this.addMembership(
        invitation.organisationId,
        user.id,
        invitation.role,
        invitation.propertyId,
      );
      const organisation = this.organisations.find((o) => o.id === invitation.organisationId);
      return this.reply(route, 200, { organisation, role: invitation.role });
    }

    const match = /^\/organisations\/([^/]+)(\/.*)?$/.exec(path);
    if (!match) return this.error(route, 404, 'NOT_FOUND');
    const organisation = this.organisations.find((o) => o.id === match[1]);
    const permissions = organisation ? this.organisationPermissions(organisation.id, user.id) : [];
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
            scopeType: m.scopeType,
            scopeId: m.scopeId,
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
      const propertyId = str('propertyId');
      if (str('role') === 'PROPERTY_MANAGER' && !propertyId)
        return this.error(route, 422, 'ROLE_SCOPE_MISMATCH');
      const invitation: FakeInvitation = {
        id: randomUUID(),
        organisationId: organisation.id,
        email: (str('email') ?? '').toLowerCase(),
        role: str('role') ?? 'FINANCE_OFFICER',
        // 43 base64url characters, like the real token.
        token: Buffer.from(randomUUID() + randomUUID())
          .toString('base64url')
          .slice(0, 43),
        status: 'PENDING',
        ...(propertyId ? { propertyId } : {}),
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

    // ------------------------------------------------------------- properties
    if (rest === '/properties') {
      if (method === 'GET') {
        const data = this.properties.filter(
          (p) =>
            p.organisationId === organisation.id &&
            this.propertyPermissions(organisation.id, p.id, user.id),
        );
        return this.reply(route, 200, { data, nextCursor: null });
      }
      if (!can('organisation.property.create')) return this.error(route, 403, 'FORBIDDEN');
      const code = (str('code') ?? '').toUpperCase();
      if (this.properties.some((p) => p.organisationId === organisation.id && p.code === code)) {
        return this.error(route, 409, 'PROPERTY_CODE_TAKEN');
      }
      const property = this.addProperty(organisation.id, str('name') ?? '', code);
      return this.reply(route, 201, property);
    }

    const propertyMatch = /^\/properties\/([^/]+)(\/.*)?$/.exec(rest);
    if (!propertyMatch) return this.error(route, 404, 'NOT_FOUND');
    const property = this.properties.find(
      (p) => p.id === propertyMatch[1] && p.organisationId === organisation.id,
    );
    const pp = property ? this.propertyPermissions(organisation.id, property.id, user.id) : null;
    if (!property || !pp) return this.error(route, 404, 'NOT_FOUND');
    const sub = propertyMatch[2] ?? '';
    const need = (permission: string) =>
      pp.includes(permission) ? null : this.error(route, 403, 'FORBIDDEN');
    const status = (url.searchParams.get('status') ?? 'ACTIVE') as Status;
    const list = <T extends { status: Status }>(rows: T[]) =>
      this.reply(route, 200, { data: rows.filter((r) => r.status === status), nextCursor: null });
    const archiveRow = (row: { status: Status; archivedAt: string | null }) => {
      row.status = 'ARCHIVED';
      row.archivedAt = now();
    };
    const mine = <T extends { propertyId: string }>(rows: T[]) =>
      rows.filter((r) => r.propertyId === property.id);

    if (sub === '' && method === 'GET')
      return this.reply(route, 200, { ...property, permissions: pp });
    if (sub === '/activate') {
      if (need('property.lifecycle.manage')) return;
      property.status = 'ACTIVE';
      return this.reply(route, 200, property);
    }
    if (sub === '/archive') {
      if (need('property.lifecycle.manage')) return;
      property.status = 'ARCHIVED';
      for (const row of [
        ...mine(this.buildings),
        ...mine(this.floors),
        ...mine(this.units),
        ...mine(this.commonAreas),
      ]) {
        if (row.status === 'ACTIVE') archiveRow(row);
      }
      return this.reply(route, 200, property);
    }

    const readOrManage = method === 'GET' ? 'property.structure.read' : 'property.structure.manage';
    if (need(readOrManage)) return;

    if (sub === '/buildings') {
      if (method === 'GET') return list(mine(this.buildings));
      const code = (str('code') ?? '').toUpperCase();
      if (mine(this.buildings).some((b) => b.code === code))
        return this.error(route, 409, 'BUILDING_CODE_TAKEN');
      const building: BuildingDto = {
        id: randomUUID(),
        propertyId: property.id,
        name: str('name') ?? '',
        code,
        status: 'ACTIVE',
        archivedAt: null,
        createdAt: now(),
      };
      this.buildings.push(building);
      return this.reply(route, 201, building);
    }
    const buildingMatch = /^\/buildings\/([^/]+)(\/.*)?$/.exec(sub);
    if (buildingMatch) {
      const building = mine(this.buildings).find((b) => b.id === buildingMatch[1]);
      if (!building) return this.error(route, 404, 'NOT_FOUND');
      const bsub = buildingMatch[2] ?? '';
      const activeUnits = (where: (u: UnitDto) => boolean) =>
        this.units.filter((u) => u.status === 'ACTIVE' && where(u)).length;
      if (bsub === '' && method === 'GET') return this.reply(route, 200, building);
      if (bsub === '/archive') {
        if (activeUnits((u) => u.buildingId === building.id) > 0)
          return this.error(route, 409, 'STRUCTURE_IN_USE');
        archiveRow(building);
        for (const f of this.floors.filter(
          (f) => f.buildingId === building.id && f.status === 'ACTIVE',
        ))
          archiveRow(f);
        return this.reply(route, 200, building);
      }
      if (bsub === '/floors') {
        const floors = this.floors.filter((f) => f.buildingId === building.id);
        if (method === 'GET') return list(floors);
        const level = body.level as number;
        if (floors.some((f) => f.level === level))
          return this.error(route, 409, 'FLOOR_LEVEL_TAKEN');
        const floor: FloorDto = {
          id: randomUUID(),
          propertyId: property.id,
          buildingId: building.id,
          level,
          name: str('name') ?? '',
          status: 'ACTIVE',
          archivedAt: null,
          createdAt: now(),
        };
        this.floors.push(floor);
        return this.reply(route, 201, floor);
      }
      const floorArchive = /^\/floors\/([^/]+)\/archive$/.exec(bsub);
      if (floorArchive) {
        const floor = this.floors.find(
          (f) => f.id === floorArchive[1] && f.buildingId === building.id,
        );
        if (!floor) return this.error(route, 404, 'NOT_FOUND');
        if (activeUnits((u) => u.floorId === floor.id) > 0)
          return this.error(route, 409, 'STRUCTURE_IN_USE');
        archiveRow(floor);
        return this.reply(route, 200, floor);
      }
    }
    if (sub === '/units') {
      if (method === 'GET') {
        const buildingId = url.searchParams.get('buildingId');
        return list(mine(this.units).filter((u) => !buildingId || u.buildingId === buildingId));
      }
      const buildingId = str('buildingId') ?? null;
      const number = str('number') ?? '';
      if (
        mine(this.units).some(
          (u) =>
            u.status === 'ACTIVE' &&
            u.buildingId === buildingId &&
            u.number.toLowerCase() === number.toLowerCase(),
        )
      ) {
        return this.error(route, 409, 'UNIT_NUMBER_TAKEN');
      }
      const area = str('areaSqm');
      const unit: UnitDto = {
        id: randomUUID(),
        propertyId: property.id,
        buildingId,
        floorId: str('floorId') ?? null,
        number,
        type: (str('type') ?? 'APARTMENT') as UnitDto['type'],
        areaSqm: area ? Number.parseFloat(area).toFixed(2) : null,
        shareRatio: null,
        status: 'ACTIVE',
        archivedAt: null,
        createdAt: now(),
      };
      this.units.push(unit);
      return this.reply(route, 201, unit);
    }
    const unitArchive = /^\/units\/([^/]+)\/archive$/.exec(sub);
    if (unitArchive) {
      const unit = mine(this.units).find((u) => u.id === unitArchive[1]);
      if (!unit) return this.error(route, 404, 'NOT_FOUND');
      archiveRow(unit);
      return this.reply(route, 200, unit);
    }
    if (sub === '/common-areas') {
      if (method === 'GET') return list(mine(this.commonAreas));
      const area: CommonAreaDto = {
        id: randomUUID(),
        propertyId: property.id,
        buildingId: null,
        name: str('name') ?? '',
        type: (str('type') ?? 'OTHER') as CommonAreaDto['type'],
        status: 'ACTIVE',
        archivedAt: null,
        createdAt: now(),
      };
      this.commonAreas.push(area);
      return this.reply(route, 201, area);
    }
    return this.error(route, 404, 'NOT_FOUND');
  }

  private invitationDto(i: FakeInvitation): InvitationDto {
    return {
      id: i.id,
      email: i.email,
      role: i.role,
      scopeType: i.propertyId ? 'PROPERTY' : 'ORGANISATION',
      scopeId: i.propertyId ?? i.organisationId,
      status: i.status,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      createdAt: now(),
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
