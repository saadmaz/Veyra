import { randomUUID } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import type {
  BuildingDto,
  CommonAreaDto,
  EmergencyContactDto,
  FloorDto,
  HouseholdMemberDto,
  InvitationDto,
  MembershipDto,
  OrganisationDto,
  OwnershipDto,
  PersonDto,
  PropertyDto,
  TenancyDto,
  UnitDto,
  VehicleDto,
  VisitDto,
  VisitorInvitationDto,
  WalkInRequestDto,
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
      'organisation.resident.read',
      'organisation.settings.manage',
    ],
    property: [
      'property.lifecycle.manage',
      'property.profile.read',
      'property.resident.manage',
      'property.resident.read',
      'property.settings.manage',
      'property.structure.manage',
      'property.structure.read',
      'unit.profile.read',
      'unit.residents.read',
      'unit.visitor.invite',
      'property.visitor.check_in',
      'property.visitor.manage',
      'property.visitor.read',
    ],
  },
  FINANCE_OFFICER: {
    organisation: ['organisation.profile.read'],
    // No resident permissions until billing needs them (data minimisation).
    property: ['property.profile.read', 'property.structure.read', 'unit.profile.read'],
  },
  PROPERTY_MANAGER: {
    organisation: [],
    property: [
      'property.profile.read',
      'property.resident.manage',
      'property.resident.read',
      'property.settings.manage',
      'property.structure.manage',
      'property.structure.read',
      'unit.profile.read',
      'unit.residents.read',
      'unit.visitor.invite',
      'property.visitor.check_in',
      'property.visitor.manage',
      'property.visitor.read',
    ],
  },
  SECURITY_SUPERVISOR: {
    organisation: [],
    property: [
      'property.profile.read',
      'property.structure.read',
      'property.visitor.check_in',
      'property.visitor.manage',
      'property.visitor.read',
    ],
  },
  SECURITY_GUARD: {
    organisation: [],
    property: ['property.profile.read', 'property.structure.read', 'property.visitor.check_in'],
  },
};

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const normaliseCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');

type FakeVisitorInvitation = VisitorInvitationDto & {
  propertyId: string;
  token: string;
  /** Without the hyphen. */
  code: string;
  createdByUserId: string;
  /** The resident login that registered the visitor; null for staff. */
  hostUserId: string | null;
};
type FakeVisit = VisitDto & { propertyId: string; walkInRequestId: string | null };
type FakeWalkIn = WalkInRequestDto & { propertyId: string };

/** Today in the property's time zone, as the API computes it. */
const todayIn = (timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());

/** Inclusive date periods; null end means open-ended. */
const overlaps = (aFrom: string, aTo: string | null, bFrom: string, bTo: string | null) =>
  aFrom <= (bTo ?? '9999-12-31') && bFrom <= (aTo ?? '9999-12-31');

const covers = (from: string, to: string | null, day: string) =>
  from <= day && (to === null || to >= day);

const dayBefore = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

function sumIsOne(parts: { shareNumerator: number; shareDenominator: number }[]): boolean {
  let n = 0n;
  let d = 1n;
  for (const p of parts) {
    n = n * BigInt(p.shareDenominator) + BigInt(p.shareNumerator) * d;
    d *= BigInt(p.shareDenominator);
  }
  return parts.length > 0 && n === d;
}

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
  visitorInvitations: FakeVisitorInvitation[] = [];
  visits: FakeVisit[] = [];
  walkIns: FakeWalkIn[] = [];
  /** userId: the login linked by an accepted resident invitation. */
  persons: (PersonDto & { organisationId: string; userId: string | null })[] = [];
  ownerships: OwnershipDto[] = [];
  tenancies: TenancyDto[] = [];
  household: HouseholdMemberDto[] = [];
  vehicles: (VehicleDto & { propertyId: string })[] = [];
  emergencyContacts: (EmergencyContactDto & { personId: string })[] = [];
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

  addUnit(propertyId: string, number: string): UnitDto {
    const unit: UnitDto = {
      id: randomUUID(),
      propertyId,
      buildingId: null,
      floorId: null,
      number,
      type: 'APARTMENT',
      areaSqm: '85.50',
      shareRatio: null,
      status: 'ACTIVE',
      archivedAt: null,
      createdAt: now(),
    };
    this.units.push(unit);
    return unit;
  }

  addPerson(organisationId: string, fullName: string, email: string | null = null): PersonDto {
    const person = {
      id: randomUUID(),
      organisationId,
      fullName,
      email,
      phone: null,
      preferredLanguage: null,
      status: 'ACTIVE' as const,
      linked: false,
      createdAt: now(),
      userId: null,
    };
    this.persons.push(person);
    const { organisationId: _o, userId: _u, ...dto } = person;
    return dto;
  }

  addOwnership(unitId: string, person: PersonDto, effectiveFrom: string, share = [1, 1]) {
    const ownership: OwnershipDto = {
      id: randomUUID(),
      unitId,
      personId: person.id,
      fullName: person.fullName,
      shareNumerator: share[0] ?? 1,
      shareDenominator: share[1] ?? 1,
      effectiveFrom,
      effectiveTo: null,
      voidedAt: null,
      voidReason: null,
    };
    this.ownerships.push(ownership);
    return ownership;
  }

  addTenancy(unitId: string, person: PersonDto, startDate: string): TenancyDto {
    const tenancy: TenancyDto = {
      id: randomUUID(),
      unitId,
      startDate,
      endDate: null,
      voidedAt: null,
      voidReason: null,
      occupants: [{ personId: person.id, fullName: person.fullName, isPrimary: true }],
    };
    this.tenancies.push(tenancy);
    return tenancy;
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

  /** Links a resident profile to a login, as accepting a resident invitation does. */
  linkPerson(personId: string, userId: string) {
    const person = this.persons.find((p) => p.id === personId);
    if (person) {
      person.userId = userId;
      person.linked = true;
    }
  }

  /** Derived resident roles of a login on a unit today (property time zone), like the API. */
  private residentRoles(userId: string, unitId: string): string[] {
    const unit = this.units.find((u) => u.id === unitId);
    const property = this.properties.find((p) => p.id === unit?.propertyId);
    if (!unit || !property) return [];
    const today = todayIn(property.timeZone);
    const mine = new Set(this.persons.filter((p) => p.userId === userId).map((p) => p.id));
    const roles = new Set<string>();
    for (const o of this.ownerships)
      if (
        o.unitId === unitId &&
        mine.has(o.personId) &&
        !o.voidedAt &&
        covers(o.effectiveFrom, o.effectiveTo, today)
      )
        roles.add('OWNER');
    for (const t of this.tenancies)
      if (
        t.unitId === unitId &&
        !t.voidedAt &&
        covers(t.startDate, t.endDate, today) &&
        t.occupants.some((o) => mine.has(o.personId))
      )
        roles.add('TENANT');
    for (const h of this.household)
      if (
        h.unitId === unitId &&
        mine.has(h.personId) &&
        !h.voidedAt &&
        covers(h.validFrom, h.validTo, today)
      )
        roles.add('HOUSEHOLD_MEMBER');
    return [...roles].sort();
  }

  private residentUnitIds(organisationId: string, userId: string): string[] {
    const propertyIds = new Set(
      this.properties.filter((p) => p.organisationId === organisationId).map((p) => p.id),
    );
    return this.units
      .filter((u) => propertyIds.has(u.propertyId) && this.residentRoles(userId, u.id).length > 0)
      .map((u) => u.id);
  }

  /** Current residents of a unit, names only (GET …/units/:id/residents). */
  private unitResidents(unitId: string, today: string) {
    const live = <T extends { voidedAt: string | null }>(rows: T[]) =>
      rows.filter((r) => !r.voidedAt);
    return {
      owners: live(this.ownerships)
        .filter((o) => o.unitId === unitId && covers(o.effectiveFrom, o.effectiveTo, today))
        .map((o) => ({
          personId: o.personId,
          fullName: o.fullName,
          shareNumerator: o.shareNumerator,
          shareDenominator: o.shareDenominator,
          since: o.effectiveFrom,
        })),
      tenants: live(this.tenancies)
        .filter((t) => t.unitId === unitId && covers(t.startDate, t.endDate, today))
        .flatMap((t) =>
          t.occupants.map((o) => ({
            personId: o.personId,
            fullName: o.fullName,
            isPrimary: o.isPrimary,
            since: t.startDate,
            until: t.endDate,
          })),
        ),
      household: live(this.household)
        .filter((h) => h.unitId === unitId && covers(h.validFrom, h.validTo, today))
        .map((h) => ({
          personId: h.personId,
          fullName: h.fullName,
          relationship: h.relationship,
          since: h.validFrom,
        })),
    };
  }

  private unitDetail(
    unit: UnitDto,
    property: PropertyDto,
    permissions: string[],
    myRoles: string[],
  ) {
    return {
      unitId: unit.id,
      unitNumber: unit.number,
      unitType: unit.type,
      status: unit.status,
      areaSqm: unit.areaSqm,
      propertyId: property.id,
      propertyName: property.name,
      propertyTimeZone: property.timeZone,
      buildingName: this.buildings.find((b) => b.id === unit.buildingId)?.name ?? null,
      floorName: this.floors.find((f) => f.id === unit.floorId)?.name ?? null,
      myRoles,
      permissions,
    };
  }

  private organisationPermissions(organisationId: string, userId: string): string[] {
    const grants = this.grants(organisationId, userId);
    if (grants.length === 0) {
      // Residents are members through their records: the baseline permission only.
      return this.residentUnitIds(organisationId, userId).length > 0
        ? ['organisation.profile.read']
        : [];
    }
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

    if (rest === '/my-units' && method === 'GET') {
      const data = this.residentUnitIds(organisation.id, user.id).map((unitId) => {
        const unit = this.units.find((u) => u.id === unitId) as UnitDto;
        const property = this.properties.find((p) => p.id === unit.propertyId) as PropertyDto;
        return {
          unitId,
          unitNumber: unit.number,
          unitType: unit.type,
          propertyId: property.id,
          propertyName: property.name,
          buildingName: this.buildings.find((b) => b.id === unit.buildingId)?.name ?? null,
          roles: this.residentRoles(user.id, unitId),
        };
      });
      return this.reply(route, 200, { data });
    }
    const personInvite = /^\/persons\/([^/]+)\/invitations$/.exec(rest);
    if (personInvite && method === 'POST') {
      if (!can('organisation.member.invite')) return this.error(route, 403, 'FORBIDDEN');
      const person = this.persons.find(
        (p) => p.id === personInvite[1] && p.organisationId === organisation.id,
      );
      if (!person) return this.error(route, 404, 'NOT_FOUND');
      if (person.linked) return this.error(route, 409, 'PERSON_ALREADY_LINKED');
      if (!person.email) return this.error(route, 422, 'PERSON_HAS_NO_EMAIL');
      const invitation: FakeInvitation = {
        id: randomUUID(),
        organisationId: organisation.id,
        email: person.email,
        role: 'RESIDENT',
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
    if (property && !pp) {
      // Residents reach only their own unit (derived roles), never the property itself.
      const own = /^\/units\/([^/]+)(\/.*)?$/.exec(propertyMatch[2] ?? '');
      const unit = own
        ? this.units.find((u) => u.id === own[1] && u.propertyId === property.id)
        : undefined;
      const roles = unit ? this.residentRoles(user.id, unit.id) : [];
      if (own && unit && roles.length > 0) {
        const permissions = ['unit.profile.read', 'unit.visitor.invite'];
        if (roles.includes('OWNER') || roles.includes('TENANT'))
          permissions.push('unit.residents.read');
        const usub = own[2] ?? '';
        if (usub === '' && method === 'GET')
          return this.reply(route, 200, this.unitDetail(unit, property, permissions.sort(), roles));
        if (usub === '/residents' && method === 'GET') {
          if (!permissions.includes('unit.residents.read'))
            return this.error(route, 403, 'FORBIDDEN');
          return this.reply(route, 200, this.unitResidents(unit.id, todayIn(property.timeZone)));
        }
        const visitors = this.visitorUnitRoute(route, method, usub, body, property, unit, user.id);
        if (visitors) return visitors;
      }
    }
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

    const visitorRoute = this.visitorPropertyRoute(
      route,
      method,
      sub,
      body,
      url,
      property,
      pp,
      user.id,
    );
    if (visitorRoute) return visitorRoute;
    const unitVisitors = /^\/units\/([^/]+)(\/(?:visitor-invitations|walk-in-requests).*)$/.exec(
      sub,
    );
    if (unitVisitors) {
      const unit = mine(this.units).find((u) => u.id === unitVisitors[1]);
      if (!unit) return this.error(route, 404, 'NOT_FOUND');
      if (!pp.includes('unit.visitor.invite')) return this.error(route, 403, 'FORBIDDEN');
      const handled = this.visitorUnitRoute(
        route,
        method,
        unitVisitors[2] ?? '',
        body,
        property,
        unit,
        user.id,
      );
      if (handled) return handled;
    }

    const residentRoute = this.residentRoute(
      route,
      method,
      sub,
      body,
      organisation.id,
      property,
      pp,
      user.id,
    );
    if (residentRoute) return residentRoute;

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

  /**
   * Residents (Phase 4): unit detail, people, ownership, tenancies, household, vehicles and
   * emergency contacts. Mirrors the API's permissions, conflict codes and residency rules.
   * Returns null when the path is not a resident route.
   */
  private residentRoute(
    route: Route,
    method: string,
    sub: string,
    body: Record<string, unknown>,
    organisationId: string,
    property: PropertyDto,
    pp: string[],
    userId: string,
  ): Promise<void> | null {
    const today = todayIn(property.timeZone);
    const str = (key: string) =>
      typeof body[key] === 'string' ? (body[key] as string) : undefined;
    const need = (permission: string) =>
      pp.includes(permission) ? null : this.error(route, 403, 'FORBIDDEN');
    const READ = 'property.resident.read';
    const MANAGE = 'property.resident.manage';
    const units = this.units.filter((u) => u.propertyId === property.id);
    const unitIds = new Set(units.map((u) => u.id));
    const person = (id: string | undefined) =>
      this.persons.find((p) => p.id === id && p.organisationId === organisationId);
    const toPerson = ({
      organisationId: _o,
      userId: _u,
      ...p
    }: (typeof this.persons)[number]): PersonDto => p;

    // ---------------------------------------------------------------- people
    if (sub === '/residents' && method === 'GET') {
      {
        const denied = need(READ);
        if (denied) return denied;
      }
      const rows = new Map<string, { unitId: string; unitNumber: string; roles: string[] }[]>();
      const addRole = (personId: string, unitId: string, role: string) => {
        const unit = units.find((u) => u.id === unitId);
        if (!unit) return;
        const list = rows.get(personId) ?? [];
        const entry = list.find((e) => e.unitId === unitId);
        if (entry) {
          if (!entry.roles.includes(role)) entry.roles.push(role);
        } else list.push({ unitId, unitNumber: unit.number, roles: [role] });
        rows.set(personId, list);
      };
      for (const o of this.ownerships)
        if (unitIds.has(o.unitId) && !o.voidedAt && covers(o.effectiveFrom, o.effectiveTo, today))
          addRole(o.personId, o.unitId, 'OWNER');
      for (const t of this.tenancies)
        if (unitIds.has(t.unitId) && !t.voidedAt && covers(t.startDate, t.endDate, today))
          for (const occupant of t.occupants) addRole(occupant.personId, t.unitId, 'TENANT');
      for (const h of this.household)
        if (unitIds.has(h.unitId) && !h.voidedAt && covers(h.validFrom, h.validTo, today))
          addRole(h.personId, h.unitId, 'HOUSEHOLD_MEMBER');
      const data = [...rows.entries()].map(([personId, list]) => ({
        person: toPerson(person(personId) as (typeof this.persons)[number]),
        units: list,
      }));
      return this.reply(route, 200, { data });
    }
    if (sub === '/persons' && method === 'GET') {
      // People staff may pick: related to this property by any record, or not attached anywhere.
      const denied = need(READ);
      if (denied) return denied;
      const related = (personId: string, inProperty: boolean) => {
        const unitOk = (unitId: string | null) =>
          !inProperty || (unitId !== null && unitIds.has(unitId));
        return (
          this.ownerships.some((o) => o.personId === personId && unitOk(o.unitId)) ||
          this.household.some((h) => h.personId === personId && unitOk(h.unitId)) ||
          this.tenancies.some(
            (t) => unitOk(t.unitId) && t.occupants.some((o) => o.personId === personId),
          ) ||
          this.vehicles.some(
            (v) => v.personId === personId && (!inProperty || v.propertyId === property.id),
          )
        );
      };
      const data = this.persons
        .filter(
          (p) =>
            p.organisationId === organisationId &&
            p.status === 'ACTIVE' &&
            (related(p.id, true) || !related(p.id, false)),
        )
        .sort((a, b) => a.fullName.localeCompare(b.fullName))
        .map(toPerson);
      return this.reply(route, 200, { data });
    }
    if (sub === '/persons' && method === 'POST') {
      {
        const denied = need(MANAGE);
        if (denied) return denied;
      }
      const email = str('email')?.toLowerCase() ?? null;
      if (
        email &&
        this.persons.some((p) => p.organisationId === organisationId && p.email === email)
      )
        return this.error(route, 409, 'PERSON_EMAIL_TAKEN');
      const phone = str('phone')?.replace(/[\s-]/g, '') ?? null;
      if (phone && !/^\+[1-9]\d{6,14}$/.test(phone))
        return this.error(route, 400, 'VALIDATION_FAILED', [
          { path: 'phone', message: 'Use international format, e.g. +923001234567' },
        ]);
      const created = this.addPerson(organisationId, str('fullName') ?? '', email);
      const stored = this.persons.find((p) => p.id === created.id);
      if (stored) {
        stored.phone = phone;
        stored.preferredLanguage = str('preferredLanguage') ?? null;
      }
      return this.reply(route, 201, toPerson(stored as (typeof this.persons)[number]));
    }
    const personMatch = /^\/persons\/([^/]+)(\/.*)?$/.exec(sub);
    if (personMatch) {
      {
        const denied = need(method === 'GET' ? READ : MANAGE);
        if (denied) return denied;
      }
      const p = person(personMatch[1]);
      if (!p) return this.error(route, 404, 'NOT_FOUND');
      const psub = personMatch[2] ?? '';
      if (psub === '' && method === 'GET') {
        const mineOnly = <T extends { unitId: string }>(rows: T[]) =>
          rows.filter((r) => unitIds.has(r.unitId));
        return this.reply(route, 200, {
          person: toPerson(p),
          ownerships: mineOnly(this.ownerships).filter((o) => o.personId === p.id),
          tenancies: mineOnly(this.tenancies).filter((t) =>
            t.occupants.some((o) => o.personId === p.id),
          ),
          household: mineOnly(this.household).filter((h) => h.personId === p.id),
          emergencyContacts: this.emergencyContacts
            .filter((c) => c.personId === p.id)
            .map(({ personId: _p, ...c }) => c),
        });
      }
      if (psub === '' && method === 'PATCH') {
        for (const key of ['fullName', 'email', 'phone', 'preferredLanguage'] as const) {
          if (key in body) Object.assign(p, { [key]: body[key] });
        }
        return this.reply(route, 200, toPerson(p));
      }
      if (psub === '/emergency-contacts' && method === 'POST') {
        const contact = {
          id: randomUUID(),
          personId: p.id,
          name: str('name') ?? '',
          phone: (str('phone') ?? '').replace(/[\s-]/g, ''),
          relationship: str('relationship') ?? null,
        };
        this.emergencyContacts.push(contact);
        const { personId: _p, ...dto } = contact;
        return this.reply(route, 201, dto);
      }
      const contactMatch = /^\/emergency-contacts\/([^/]+)$/.exec(psub);
      if (contactMatch && method === 'DELETE') {
        const index = this.emergencyContacts.findIndex(
          (c) => c.id === contactMatch[1] && c.personId === p.id,
        );
        if (index < 0) return this.error(route, 404, 'NOT_FOUND');
        this.emergencyContacts.splice(index, 1);
        return this.reply(route, 204);
      }
      return this.error(route, 404, 'NOT_FOUND');
    }

    // ---------------------------------------------------------------- vehicles
    if (sub === '/vehicles') {
      {
        const denied = need(method === 'GET' ? READ : MANAGE);
        if (denied) return denied;
      }
      if (method === 'GET') {
        const data = this.vehicles
          .filter((v) => v.propertyId === property.id && v.status === 'ACTIVE')
          .map(({ propertyId: _p, ...v }) => v);
        return this.reply(route, 200, { data });
      }
      const plate = (str('plate') ?? '').toUpperCase().replace(/\s+/g, '');
      if (
        this.vehicles.some(
          (v) => v.propertyId === property.id && v.status === 'ACTIVE' && v.plate === plate,
        )
      )
        return this.error(route, 409, 'PLATE_TAKEN');
      const vehicle = {
        id: randomUUID(),
        propertyId: property.id,
        plate,
        make: str('make') ?? null,
        model: str('model') ?? null,
        colour: str('colour') ?? null,
        unitId: str('unitId') ?? null,
        personId: str('personId') ?? null,
        status: 'ACTIVE' as const,
      };
      this.vehicles.push(vehicle);
      const { propertyId: _p, ...dto } = vehicle;
      return this.reply(route, 201, dto);
    }
    const vehicleArchive = /^\/vehicles\/([^/]+)\/archive$/.exec(sub);
    if (vehicleArchive) {
      {
        const denied = need(MANAGE);
        if (denied) return denied;
      }
      const vehicle = this.vehicles.find(
        (v) => v.id === vehicleArchive[1] && v.propertyId === property.id,
      );
      if (!vehicle) return this.error(route, 404, 'NOT_FOUND');
      vehicle.status = 'ARCHIVED';
      const { propertyId: _p, ...dto } = vehicle;
      return this.reply(route, 200, dto);
    }

    // ---------------------------------------------------------------- one unit
    const unitMatch = /^\/units\/([^/]+)(\/.*)?$/.exec(sub);
    if (!unitMatch || /^\/archive$/.test(unitMatch[2] ?? '')) return null;
    const unit = units.find((u) => u.id === unitMatch[1]);
    if (!unit) return this.error(route, 404, 'NOT_FOUND');
    const usub = unitMatch[2] ?? '';
    const writable = () => (unit.status === 'ARCHIVED' ? this.error(route, 409, 'ARCHIVED') : null);

    if (usub === '' && method === 'GET') {
      {
        const denied = need('unit.profile.read');
        if (denied) return denied;
      }
      return this.reply(
        route,
        200,
        this.unitDetail(unit, property, pp, this.residentRoles(userId, unit.id)),
      );
    }
    {
      const denied = need(method === 'GET' ? READ : MANAGE);
      if (denied) return denied;
    }
    if (usub === '/residents' && method === 'GET') {
      const denied = need('unit.residents.read');
      if (denied) return denied;
      return this.reply(route, 200, this.unitResidents(unit.id, today));
    }
    const ownerships = this.ownerships.filter((o) => o.unitId === unit.id);
    const tenancies = this.tenancies.filter((t) => t.unitId === unit.id);
    const household = this.household.filter((h) => h.unitId === unit.id);

    if (usub === '/ownerships' && method === 'GET')
      return this.reply(route, 200, { data: ownerships });
    if (usub === '/owners' && method === 'POST') {
      if (writable()) return writable();
      const effectiveFrom = str('effectiveFrom') ?? '';
      const owners = (body.owners ?? []) as {
        personId: string;
        shareNumerator: number;
        shareDenominator: number;
      }[];
      if (!sumIsOne(owners))
        return this.error(route, 400, 'VALIDATION_FAILED', [
          { path: 'owners', message: 'Shares must add up to exactly one' },
        ]);
      const live = ownerships.filter((o) => !o.voidedAt);
      if (live.some((o) => o.effectiveFrom >= effectiveFrom))
        return this.error(route, 409, 'OWNERSHIP_CONFLICT');
      for (const o of live)
        if (o.effectiveTo === null || o.effectiveTo >= effectiveFrom)
          o.effectiveTo = dayBefore(effectiveFrom);
      for (const owner of owners) {
        const p = person(owner.personId);
        if (!p) return this.error(route, 404, 'NOT_FOUND');
        this.addOwnership(unit.id, p, effectiveFrom, [
          owner.shareNumerator,
          owner.shareDenominator,
        ]);
      }
      return this.reply(route, 200, { data: this.ownerships.filter((o) => o.unitId === unit.id) });
    }
    if (usub === '/ownerships/void' && method === 'POST') {
      const ids = (body.ownershipIds ?? []) as string[];
      const voiding = ownerships.filter((o) => ids.includes(o.id) && !o.voidedAt);
      // Like the database check: owners recorded together must be voided together.
      const partial = voiding.some((v) =>
        ownerships.some(
          (o) => !o.voidedAt && o.effectiveFrom === v.effectiveFrom && !ids.includes(o.id),
        ),
      );
      if (partial) return this.error(route, 409, 'RESIDENCY_RULE_VIOLATED');
      for (const o of voiding) {
        o.voidedAt = now();
        o.voidReason = str('reason') ?? null;
      }
      return this.reply(route, 200, { data: ownerships });
    }

    if (usub === '/tenancies') {
      if (method === 'GET') return this.reply(route, 200, { data: tenancies });
      if (writable()) return writable();
      const startDate = str('startDate') ?? '';
      const endDate = str('endDate') ?? null;
      if (
        tenancies.some((t) => !t.voidedAt && overlaps(t.startDate, t.endDate, startDate, endDate))
      )
        return this.error(route, 409, 'TENANCY_OVERLAP');
      const occupants = (body.occupants ?? []) as { personId: string; isPrimary: boolean }[];
      const tenancy: TenancyDto = {
        id: randomUUID(),
        unitId: unit.id,
        startDate,
        endDate,
        voidedAt: null,
        voidReason: null,
        occupants: occupants.map((o) => ({
          personId: o.personId,
          fullName: person(o.personId)?.fullName ?? '',
          isPrimary: o.isPrimary,
        })),
      };
      this.tenancies.push(tenancy);
      return this.reply(route, 201, tenancy);
    }
    const tenancyMatch = /^\/tenancies\/([^/]+)\/(end|void)$/.exec(usub);
    if (tenancyMatch) {
      const tenancy = tenancies.find((t) => t.id === tenancyMatch[1]);
      if (!tenancy) return this.error(route, 404, 'NOT_FOUND');
      if (tenancy.voidedAt) return this.error(route, 409, 'VOIDED');
      if (tenancyMatch[2] === 'end') {
        const endDate = str('endDate') ?? '';
        if (endDate < tenancy.startDate) return this.error(route, 422, 'INVALID_PERIOD');
        tenancy.endDate = endDate;
      } else {
        tenancy.voidedAt = now();
        tenancy.voidReason = str('reason') ?? null;
      }
      return this.reply(route, 200, tenancy);
    }

    if (usub === '/household') {
      if (method === 'GET') return this.reply(route, 200, { data: household });
      if (writable()) return writable();
      const personId = str('personId') ?? '';
      const validFrom = str('validFrom') ?? '';
      const validTo = str('validTo') ?? null;
      if (
        household.some(
          (h) =>
            !h.voidedAt &&
            h.personId === personId &&
            overlaps(h.validFrom, h.validTo, validFrom, validTo),
        )
      )
        return this.error(route, 409, 'HOUSEHOLD_OVERLAP');
      const member: HouseholdMemberDto = {
        id: randomUUID(),
        unitId: unit.id,
        personId,
        fullName: person(personId)?.fullName ?? '',
        relationship: str('relationship') ?? 'OTHER',
        validFrom,
        validTo,
        voidedAt: null,
      };
      this.household.push(member);
      return this.reply(route, 201, member);
    }
    const memberMatch = /^\/household\/([^/]+)\/(end|void)$/.exec(usub);
    if (memberMatch) {
      const member = household.find((h) => h.id === memberMatch[1]);
      if (!member) return this.error(route, 404, 'NOT_FOUND');
      if (member.voidedAt) return this.error(route, 409, 'VOIDED');
      if (memberMatch[2] === 'end') {
        const endDate = str('endDate') ?? '';
        if (endDate < member.validFrom) return this.error(route, 422, 'INVALID_PERIOD');
        member.validTo = endDate;
      } else member.voidedAt = now();
      return this.reply(route, 200, member);
    }
    return null;
  }

  // ------------------------------------------------------------------ visitors (Phase 5)

  private visitorDto(i: FakeVisitorInvitation): VisitorInvitationDto {
    const { propertyId: _p, token: _t, code: _c, createdByUserId, hostUserId: _h, ...dto } = i;
    return {
      ...dto,
      entriesUsed: this.visits.filter((v) => v.invitationId === i.id && v.decision === 'ADMITTED')
        .length,
      createdByMe: createdByUserId === this.currentUserId,
    };
  }

  private visitDto({ propertyId: _p, walkInRequestId: _w, ...v }: FakeVisit): VisitDto {
    return v;
  }

  private walkInDto({ propertyId: _p, ...r }: FakeWalkIn): WalkInRequestDto {
    const expired = r.status === 'PENDING' && Date.parse(r.expiresAt) < Date.now();
    return {
      ...r,
      status: expired ? 'EXPIRED' : r.status,
      used: this.visits.some((v) => v.walkInRequestId === r.id),
    };
  }

  /** Why a pass is refused now, or null; same order as the API. */
  private passProblem(i: FakeVisitorInvitation) {
    const now = Date.now();
    if (i.status === 'REVOKED') return 'REVOKED';
    if (now < Date.parse(i.validFrom)) return 'NOT_YET_VALID';
    if (now > Date.parse(i.validUntil)) return 'EXPIRED';
    if (this.visitorDto(i).entriesUsed >= i.maxEntries) return 'NO_ENTRIES_LEFT';
    if (i.hostUserId && this.residentRoles(i.hostUserId, i.unitId).length === 0)
      return 'HOST_NO_LONGER_RESIDENT';
    return null;
  }

  private newVisit(
    property: PropertyDto,
    userId: string,
    fields: Omit<FakeVisit, 'id' | 'propertyId' | 'arrivedAt' | 'departedAt' | 'source'>,
  ): FakeVisit {
    const visit: FakeVisit = {
      id: randomUUID(),
      propertyId: property.id,
      arrivedAt: now(),
      departedAt: null,
      source: 'ONLINE',
      ...fields,
    };
    void userId;
    this.visits.push(visit);
    return visit;
  }

  /** A unit's visitors and walk-in requests, for its residents and for staff. */
  private visitorUnitRoute(
    route: Route,
    method: string,
    usub: string,
    body: Record<string, unknown>,
    property: PropertyDto,
    unit: UnitDto,
    userId: string,
  ): Promise<void> | null {
    const str = (key: string) =>
      typeof body[key] === 'string' ? (body[key] as string) : undefined;
    const resident = this.residentRoles(userId, unit.id).length > 0;
    if (usub === '/visitor-invitations') {
      if (method === 'GET') {
        const data = this.visitorInvitations
          .filter((i) => i.unitId === unit.id)
          .map((i) => this.visitorDto(i));
        return this.reply(route, 200, { data });
      }
      if (unit.status === 'ARCHIVED') return this.error(route, 409, 'ARCHIVED');
      const validFrom = str('validFrom') ?? '';
      const validUntil = str('validUntil') ?? '';
      if (!(Date.parse(validUntil) > Date.parse(validFrom)))
        return this.error(route, 400, 'VALIDATION_FAILED', [
          { path: 'validUntil', message: 'The end must be after the start' },
        ]);
      let code = '';
      for (let i = 0; i < 8; i += 1)
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      const token = Buffer.from(randomUUID() + randomUUID())
        .toString('base64url')
        .slice(0, 43);
      const invitation: FakeVisitorInvitation = {
        id: randomUUID(),
        propertyId: property.id,
        unitId: unit.id,
        unitNumber: unit.number,
        category: (str('category') ?? 'GUEST') as VisitorInvitationDto['category'],
        visitorName: (str('visitorName') ?? '').trim(),
        visitorPhone: str('visitorPhone')?.replace(/[\s-]/g, '') ?? null,
        vehiclePlate: str('vehiclePlate')?.toUpperCase().replace(/\s+/g, '') ?? null,
        validFrom: new Date(validFrom).toISOString(),
        validUntil: new Date(validUntil).toISOString(),
        maxEntries: typeof body.maxEntries === 'number' ? body.maxEntries : 1,
        entriesUsed: 0,
        status: 'ACTIVE',
        revokedAt: null,
        createdByMe: true,
        createdAt: now(),
        token,
        code,
        createdByUserId: userId,
        hostUserId: resident ? userId : null,
      };
      this.visitorInvitations.push(invitation);
      return this.reply(route, 201, {
        invitation: this.visitorDto(invitation),
        pass: { token, code: `${code.slice(0, 4)}-${code.slice(4)}` },
      });
    }
    const revoke = /^\/visitor-invitations\/([^/]+)\/revoke$/.exec(usub);
    if (revoke && method === 'POST') {
      const invitation = this.visitorInvitations.find(
        (i) => i.id === revoke[1] && i.unitId === unit.id,
      );
      if (!invitation) return this.error(route, 404, 'NOT_FOUND');
      if (invitation.status === 'ACTIVE') {
        invitation.status = 'REVOKED';
        invitation.revokedAt = now();
      }
      return this.reply(route, 200, this.visitorDto(invitation));
    }
    if (usub === '/walk-in-requests' && method === 'GET') {
      const data = this.walkIns
        .filter((r) => r.unitId === unit.id)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((r) => this.walkInDto(r));
      return this.reply(route, 200, { data });
    }
    const decide = /^\/walk-in-requests\/([^/]+)\/(approve|deny)$/.exec(usub);
    if (decide && method === 'POST') {
      // Only residents of the unit answer; staff are refused (owner decision).
      if (!resident) return this.error(route, 403, 'FORBIDDEN');
      const request = this.walkIns.find((r) => r.id === decide[1] && r.unitId === unit.id);
      if (!request) return this.error(route, 404, 'NOT_FOUND');
      const state = this.walkInDto(request).status;
      if (state === 'EXPIRED') return this.error(route, 409, 'WALK_IN_EXPIRED');
      if (state !== 'PENDING') return this.error(route, 409, 'WALK_IN_NOT_PENDING');
      request.status = decide[2] === 'approve' ? 'APPROVED' : 'DENIED';
      request.decidedAt = now();
      request.approvalValidUntil =
        request.status === 'APPROVED' ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
      return this.reply(route, 200, this.walkInDto(request));
    }
    return null;
  }

  /** The gate, the visit log and the property's invitations, for staff. */
  private visitorPropertyRoute(
    route: Route,
    method: string,
    sub: string,
    body: Record<string, unknown>,
    url: URL,
    property: PropertyDto,
    pp: string[],
    userId: string,
  ): Promise<void> | null {
    const str = (key: string) =>
      typeof body[key] === 'string' ? (body[key] as string) : undefined;
    const gate = str('gate') ?? null;
    const needs = (permission: string) =>
      pp.includes(permission) ? null : this.error(route, 403, 'FORBIDDEN');
    const mineInvitations = this.visitorInvitations.filter((i) => i.propertyId === property.id);
    const gateRoute = sub.startsWith('/gate/') || sub.startsWith('/visits');

    if (gateRoute && !sub.startsWith('/visits?') && sub !== '/visits') {
      const denied = needs('property.visitor.check_in');
      if (denied) return denied;
    }

    if (sub === '/gate/validate' && method === 'POST') {
      const token = str('token');
      const code = str('code');
      const invitation = mineInvitations.find((i) =>
        token ? i.token === token : code !== undefined && i.code === normaliseCode(code),
      );
      if (!invitation) return this.reply(route, 200, { valid: false, reason: 'NOT_FOUND' });
      const problem = this.passProblem(invitation);
      if (problem) return this.reply(route, 200, { valid: false, reason: problem });
      const dto = this.visitorDto(invitation);
      return this.reply(route, 200, {
        valid: true,
        pass: {
          invitationId: invitation.id,
          passId: invitation.id,
          category: invitation.category,
          visitorName: invitation.visitorName,
          vehiclePlate: invitation.vehiclePlate,
          unitNumber: invitation.unitNumber,
          validUntil: invitation.validUntil,
          entriesLeft: invitation.maxEntries - dto.entriesUsed,
        },
      });
    }
    if (sub === '/gate/admit' && method === 'POST') {
      const invitation = mineInvitations.find((i) => i.id === str('passId'));
      if (!invitation) return this.error(route, 404, 'NOT_FOUND');
      if (this.passProblem(invitation)) return this.error(route, 409, 'PASS_NOT_VALID');
      const visit = this.newVisit(property, userId, {
        unitId: invitation.unitId,
        unitNumber: invitation.unitNumber,
        invitationId: invitation.id,
        category: invitation.category,
        visitorName: invitation.visitorName,
        vehiclePlate: invitation.vehiclePlate,
        decision: 'ADMITTED',
        denialReason: null,
        gate,
        walkInRequestId: null,
      });
      return this.reply(route, 201, this.visitDto(visit));
    }
    if (sub === '/gate/deny' && method === 'POST') {
      const invitation = mineInvitations.find((i) => i.id === str('passId'));
      const visit = this.newVisit(property, userId, {
        unitId: invitation?.unitId ?? null,
        unitNumber: invitation?.unitNumber ?? null,
        invitationId: invitation?.id ?? null,
        category: invitation?.category ?? ((str('category') ?? 'GUEST') as VisitDto['category']),
        visitorName: invitation?.visitorName ?? str('visitorName') ?? '',
        vehiclePlate: invitation?.vehiclePlate ?? null,
        decision: 'DENIED',
        denialReason: str('reason') ?? '',
        gate,
        walkInRequestId: null,
      });
      return this.reply(route, 201, this.visitDto(visit));
    }
    if (sub === '/gate/walk-in' && method === 'POST') {
      if (str('unitId')) return this.error(route, 409, 'WALK_IN_NEEDS_APPROVAL');
      const visit = this.newVisit(property, userId, {
        unitId: null,
        unitNumber: null,
        invitationId: null,
        category: (str('category') ?? 'GUEST') as VisitDto['category'],
        visitorName: str('visitorName') ?? '',
        vehiclePlate: str('vehiclePlate')?.toUpperCase().replace(/\s+/g, '') ?? null,
        decision: 'ADMITTED',
        denialReason: null,
        gate,
        walkInRequestId: null,
      });
      return this.reply(route, 201, this.visitDto(visit));
    }
    if (sub === '/gate/walk-in-requests') {
      if (method === 'GET') {
        const data = this.walkIns
          .filter((r) => r.propertyId === property.id)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .map((r) => this.walkInDto(r));
        return this.reply(route, 200, { data });
      }
      const unit = this.units.find((u) => u.id === str('unitId') && u.propertyId === property.id);
      if (!unit) return this.error(route, 404, 'NOT_FOUND');
      const open = this.walkIns.filter(
        (r) => r.unitId === unit.id && this.walkInDto(r).status === 'PENDING',
      );
      if (open.length >= 5) return this.error(route, 409, 'TOO_MANY_WALK_IN_REQUESTS');
      const request: FakeWalkIn = {
        id: randomUUID(),
        propertyId: property.id,
        unitId: unit.id,
        unitNumber: unit.number,
        category: (str('category') ?? 'GUEST') as WalkInRequestDto['category'],
        visitorName: str('visitorName') ?? '',
        visitorPhone: str('visitorPhone') ?? null,
        vehiclePlate: str('vehiclePlate')?.toUpperCase().replace(/\s+/g, '') ?? null,
        gate,
        status: 'PENDING',
        createdAt: now(),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        decidedAt: null,
        approvalValidUntil: null,
        used: false,
      };
      this.walkIns.push(request);
      return this.reply(route, 201, this.walkInDto(request));
    }
    const walkIn = /^\/gate\/walk-in-requests\/([^/]+)(\/admit|\/cancel)?$/.exec(sub);
    if (walkIn) {
      const request = this.walkIns.find((r) => r.id === walkIn[1] && r.propertyId === property.id);
      if (!request) return this.error(route, 404, 'NOT_FOUND');
      if (!walkIn[2]) return this.reply(route, 200, this.walkInDto(request));
      if (walkIn[2] === '/cancel') {
        if (request.status !== 'PENDING') return this.error(route, 409, 'WALK_IN_NOT_PENDING');
        request.status = 'CANCELLED';
        request.decidedAt = now();
        return this.reply(route, 200, this.walkInDto(request));
      }
      const dto = this.walkInDto(request);
      if (dto.status !== 'APPROVED' || dto.used)
        return this.error(route, 409, 'WALK_IN_NOT_APPROVED');
      const visit = this.newVisit(property, userId, {
        unitId: request.unitId,
        unitNumber: request.unitNumber,
        invitationId: null,
        category: request.category,
        visitorName: request.visitorName,
        vehiclePlate: request.vehiclePlate,
        decision: 'ADMITTED',
        denialReason: null,
        gate: gate ?? request.gate,
        walkInRequestId: request.id,
      });
      return this.reply(route, 201, this.visitDto(visit));
    }
    if (sub === '/visits/inside' && method === 'GET') {
      const data = this.visits
        .filter((v) => v.propertyId === property.id && v.decision === 'ADMITTED' && !v.departedAt)
        .map((v) => this.visitDto(v));
      return this.reply(route, 200, { data });
    }
    const depart = /^\/visits\/([^/]+)\/depart$/.exec(sub);
    if (depart && method === 'POST') {
      const visit = this.visits.find((v) => v.id === depart[1] && v.propertyId === property.id);
      if (!visit) return this.error(route, 404, 'NOT_FOUND');
      if (visit.departedAt) return this.error(route, 409, 'VISIT_ALREADY_DEPARTED');
      visit.departedAt = now();
      return this.reply(route, 200, this.visitDto(visit));
    }
    if (sub === '/visits' && method === 'GET') {
      const denied = needs('property.visitor.read');
      if (denied) return denied;
      const from = Date.parse(url.searchParams.get('from') ?? '');
      const to = Date.parse(url.searchParams.get('to') ?? '');
      const data = this.visits
        .filter((v) => {
          const at = Date.parse(v.arrivedAt);
          return v.propertyId === property.id && at >= from && at < to;
        })
        .map((v) => this.visitDto(v));
      return this.reply(route, 200, { data });
    }
    if (sub === '/visitor-invitations' && method === 'GET') {
      const denied = needs('property.visitor.read');
      if (denied) return denied;
      return this.reply(route, 200, { data: mineInvitations.map((i) => this.visitorDto(i)) });
    }
    const revoke = /^\/visitor-invitations\/([^/]+)\/revoke$/.exec(sub);
    if (revoke && method === 'POST') {
      const denied = needs('property.visitor.manage');
      if (denied) return denied;
      const invitation = mineInvitations.find((i) => i.id === revoke[1]);
      if (!invitation) return this.error(route, 404, 'NOT_FOUND');
      invitation.status = 'REVOKED';
      invitation.revokedAt = now();
      return this.reply(route, 200, this.visitorDto(invitation));
    }
    return null;
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
    // Echo a local console origin, so the suite also runs on another port (e.g. while a dev
    // server holds 3000); anything else gets the default and fails CORS, like the real API.
    const origin = route.request().headers().origin;
    return route.fulfill({
      status,
      headers: {
        'Access-Control-Allow-Origin':
          origin && /^http:\/\/localhost:\d+$/.test(origin) ? origin : ORIGIN,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
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
