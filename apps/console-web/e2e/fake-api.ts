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
  MyUnitDto,
  OrganisationDto,
  OwnershipDto,
  PersonDto,
  PropertyDto,
  PropertyResidentDto,
  TenancyDto,
  UnitDetailResponse,
  UnitDto,
  UnitResidentsResponse,
  VehicleDto,
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
  /** Resident invitations link this person profile on acceptance. */
  personId?: string;
}

interface FakePerson extends PersonDto {
  organisationId: string;
  userId: string | null;
  contacts: EmergencyContactDto[];
}

/** Mirrors apps/api access-control roles: permissions per evaluation scope. */
const ROLES: Record<string, { organisation: string[]; property: string[]; unit: string[] }> = {
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
    ],
    unit: ['unit.profile.read', 'unit.residents.read'],
  },
  FINANCE_OFFICER: {
    organisation: ['organisation.profile.read'],
    property: ['property.profile.read', 'property.structure.read'],
    unit: ['unit.profile.read'],
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
    ],
    unit: ['unit.profile.read', 'unit.residents.read'],
  },
};

/** Derived resident roles (never assigned): unit permissions only. */
const RESIDENT_UNIT_PERMISSIONS: Record<string, string[]> = {
  OWNER: ['unit.profile.read', 'unit.residents.read'],
  TENANT: ['unit.profile.read', 'unit.residents.read'],
  HOUSEHOLD_MEMBER: ['unit.profile.read'],
};

type Status = 'ACTIVE' | 'ARCHIVED';
const now = () => new Date().toISOString();
/** Today as YYYY-MM-DD; the fake ignores property time zones. */
const today = () => new Date().toISOString().slice(0, 10);
const isCurrent = (from: string, to: string | null, voidedAt: string | null) =>
  voidedAt === null && from <= today() && (to === null || to >= today());
const dayBefore = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const overlaps = (aFrom: string, aTo: string | null, bFrom: string, bTo: string | null) =>
  aFrom <= (bTo ?? '9999-12-31') && bFrom <= (aTo ?? '9999-12-31');
const PHONE = /^\+[1-9]\d{6,14}$/;
/** Exact: a/b + c/d … equals one, using BigInt like the API. */
function sharesSumToOne(parts: { shareNumerator: number; shareDenominator: number }[]) {
  let n = 0n;
  let d = 1n;
  for (const p of parts) {
    n = n * BigInt(p.shareDenominator) + BigInt(p.shareNumerator) * d;
    d *= BigInt(p.shareDenominator);
  }
  return parts.length > 0 && n === d;
}

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
  persons: FakePerson[] = [];
  ownerships: OwnershipDto[] = [];
  tenancies: TenancyDto[] = [];
  household: HouseholdMemberDto[] = [];
  vehicles: (VehicleDto & { propertyId: string })[] = [];
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
      areaSqm: null,
      shareRatio: null,
      status: 'ACTIVE',
      archivedAt: null,
      createdAt: now(),
    };
    this.units.push(unit);
    return unit;
  }

  addPerson(
    organisationId: string,
    fullName: string,
    email: string | null = null,
    userId: string | null = null,
  ): FakePerson {
    const person: FakePerson = {
      id: randomUUID(),
      organisationId,
      fullName,
      email,
      phone: null,
      preferredLanguage: null,
      status: 'ACTIVE',
      linked: userId !== null,
      createdAt: now(),
      userId,
      contacts: [],
    };
    this.persons.push(person);
    return person;
  }

  /** Records a sole owner from a date (test seeding; the console uses POST …/owners). */
  addOwnership(unitId: string, personId: string, effectiveFrom = '2026-01-01') {
    const person = this.persons.find((p) => p.id === personId) as FakePerson;
    this.ownerships.push({
      id: randomUUID(),
      unitId,
      personId,
      fullName: person.fullName,
      shareNumerator: 1,
      shareDenominator: 1,
      effectiveFrom,
      effectiveTo: null,
      voidedAt: null,
      voidReason: null,
    });
  }

  addHouseholdMember(unitId: string, personId: string, relationship = 'CHILD') {
    const person = this.persons.find((p) => p.id === personId) as FakePerson;
    this.household.push({
      id: randomUUID(),
      unitId,
      personId,
      fullName: person.fullName,
      relationship,
      validFrom: '2026-01-01',
      validTo: null,
      voidedAt: null,
    });
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

  /** Roles today from records, for the given people on one unit (mirrors app_resident_grants). */
  private rolesOn(personIds: string[], unitId: string): string[] {
    const roles: string[] = [];
    const has = (id: string) => personIds.includes(id);
    if (
      this.ownerships.some(
        (o) =>
          o.unitId === unitId &&
          has(o.personId) &&
          isCurrent(o.effectiveFrom, o.effectiveTo, o.voidedAt),
      )
    )
      roles.push('OWNER');
    if (
      this.tenancies.some(
        (t) =>
          t.unitId === unitId &&
          isCurrent(t.startDate, t.endDate, t.voidedAt) &&
          t.occupants.some((o) => has(o.personId)),
      )
    )
      roles.push('TENANT');
    if (
      this.household.some(
        (h) =>
          h.unitId === unitId && has(h.personId) && isCurrent(h.validFrom, h.validTo, h.voidedAt),
      )
    )
      roles.push('HOUSEHOLD_MEMBER');
    return roles;
  }

  private linkedPersonIds(userId: string) {
    return this.persons.filter((p) => p.userId === userId).map((p) => p.id);
  }

  private myUnits(organisationId: string, userId: string): MyUnitDto[] {
    const personIds = this.linkedPersonIds(userId);
    const rows: MyUnitDto[] = [];
    for (const unit of this.units) {
      const property = this.properties.find((p) => p.id === unit.propertyId);
      if (unit.status !== 'ACTIVE' || property?.organisationId !== organisationId) continue;
      const roles = this.rolesOn(personIds, unit.id);
      if (roles.length === 0) continue;
      rows.push({
        unitId: unit.id,
        unitNumber: unit.number,
        unitType: unit.type,
        propertyId: property.id,
        propertyName: property.name,
        buildingName: this.buildings.find((b) => b.id === unit.buildingId)?.name ?? null,
        roles,
      });
    }
    return rows;
  }

  private organisationPermissions(organisationId: string, userId: string): string[] {
    const grants = this.grants(organisationId, userId);
    if (grants.length === 0) {
      // Residents without staff roles are members through their records: baseline only.
      return this.myUnits(organisationId, userId).length > 0 ? ['organisation.profile.read'] : [];
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
            roles: [
              ...new Set([
                ...this.grants(organisation.id, user.id).map((g) => g.role),
                ...this.myUnits(organisation.id, user.id).flatMap((u) => u.roles),
              ]),
            ].sort(),
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
      if (invitation.personId) {
        // Resident invitation: links the profile; access then comes from the records.
        const person = this.persons.find((p) => p.id === invitation.personId) as FakePerson;
        if (person.userId) return this.error(route, 409, 'PERSON_ALREADY_LINKED');
        if (
          this.persons.some(
            (p) => p.organisationId === invitation.organisationId && p.userId === user.id,
          )
        )
          return this.error(route, 409, 'USER_ALREADY_LINKED');
        person.userId = user.id;
        person.linked = true;
      } else {
        this.addMembership(
          invitation.organisationId,
          user.id,
          invitation.role,
          invitation.propertyId,
        );
      }
      invitation.status = 'ACCEPTED';
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

    // ------------------------------------------------------------- residents (organisation)
    if (rest === '/my-units' && method === 'GET') {
      return this.reply(route, 200, { data: this.myUnits(organisation.id, user.id) });
    }
    const residentInvite = /^\/persons\/([^/]+)\/invitations$/.exec(rest);
    if (residentInvite && method === 'POST') {
      if (!can('organisation.member.invite')) return this.error(route, 403, 'FORBIDDEN');
      const person = this.persons.find(
        (p) => p.id === residentInvite[1] && p.organisationId === organisation.id,
      );
      if (!person) return this.error(route, 404, 'NOT_FOUND');
      if (person.userId) return this.error(route, 409, 'PERSON_ALREADY_LINKED');
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
        personId: person.id,
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
    const sub = propertyMatch[2] ?? '';

    // Unit pages are reachable by staff (grants covering the property) and by the unit's own
    // residents (derived roles), so they are answered before the property-access check.
    const unitView = /^\/units\/([^/]+)(\/residents)?$/.exec(sub);
    if (property && unitView && method === 'GET') {
      const unit = this.units.find((u) => u.id === unitView[1] && u.propertyId === property.id);
      const staffUnit = this.grants(organisation.id, user.id)
        .filter((g) => g.scopeType === 'ORGANISATION' || g.scopeId === property.id)
        .flatMap((g) => ROLES[g.role]?.unit ?? []);
      const myRoles = unit ? this.rolesOn(this.linkedPersonIds(user.id), unit.id) : [];
      const unitPermissions = [
        ...new Set([...staffUnit, ...myRoles.flatMap((r) => RESIDENT_UNIT_PERMISSIONS[r] ?? [])]),
      ].sort();
      if (!unit || unitPermissions.length === 0) return this.error(route, 404, 'NOT_FOUND');
      if (unitView[2]) {
        if (!unitPermissions.includes('unit.residents.read'))
          return this.error(route, 403, 'FORBIDDEN');
        const name = (id: string) => this.persons.find((p) => p.id === id)?.fullName ?? '';
        const response: UnitResidentsResponse = {
          owners: this.ownerships
            .filter(
              (o) => o.unitId === unit.id && isCurrent(o.effectiveFrom, o.effectiveTo, o.voidedAt),
            )
            .map((o) => ({
              personId: o.personId,
              fullName: o.fullName,
              shareNumerator: o.shareNumerator,
              shareDenominator: o.shareDenominator,
              since: o.effectiveFrom,
            })),
          tenants: this.tenancies
            .filter((t) => t.unitId === unit.id && isCurrent(t.startDate, t.endDate, t.voidedAt))
            .flatMap((t) =>
              t.occupants.map((o) => ({
                personId: o.personId,
                fullName: name(o.personId),
                isPrimary: o.isPrimary,
                since: t.startDate,
                until: t.endDate,
              })),
            ),
          household: this.household
            .filter((h) => h.unitId === unit.id && isCurrent(h.validFrom, h.validTo, h.voidedAt))
            .map((h) => ({
              personId: h.personId,
              fullName: h.fullName,
              relationship: h.relationship,
              since: h.validFrom,
            })),
        };
        return this.reply(route, 200, response);
      }
      const detail: UnitDetailResponse = {
        unitId: unit.id,
        unitNumber: unit.number,
        unitType: unit.type,
        status: unit.status,
        areaSqm: unit.areaSqm,
        propertyId: property.id,
        propertyName: property.name,
        buildingName: this.buildings.find((b) => b.id === unit.buildingId)?.name ?? null,
        floorName: this.floors.find((f) => f.id === unit.floorId)?.name ?? null,
        myRoles,
        permissions: unitPermissions,
      };
      return this.reply(route, 200, detail);
    }

    if (!property || !pp) return this.error(route, 404, 'NOT_FOUND');
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

    const residents = this.handleResidents(
      route,
      method,
      sub,
      body,
      url,
      organisation,
      property,
      pp,
    );
    if (residents) return residents;

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
      if (
        this.rolesOn(
          this.persons.map((p) => p.id),
          unit.id,
        ).length > 0
      )
        return this.error(route, 409, 'UNIT_OCCUPIED');
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
   * Staff resident routes under a property (property.resident.read / .manage). Returns undefined
   * when the path is not a resident route.
   */
  private handleResidents(
    route: Route,
    method: string,
    sub: string,
    body: Record<string, unknown>,
    url: URL,
    organisation: OrganisationDto,
    property: PropertyDto,
    pp: string[],
  ): Promise<void> | undefined {
    const isResidentRoute =
      /^\/(residents|persons|vehicles)(\/|$)/.test(sub) ||
      /^\/units\/[^/]+\/(ownerships|owners|tenancies|household)(\/|$)/.test(sub);
    if (!isResidentRoute) return undefined;
    const permission = method === 'GET' ? 'property.resident.read' : 'property.resident.manage';
    if (!pp.includes(permission)) return this.error(route, 403, 'FORBIDDEN');
    const str = (key: string) =>
      typeof body[key] === 'string' ? (body[key] as string).trim() : undefined;
    const invalid = (path: string, message: string) =>
      this.error(route, 400, 'VALIDATION_FAILED', [{ path, message }]);
    const unitIds = this.units.filter((u) => u.propertyId === property.id).map((u) => u.id);
    const inProperty = (r: { unitId: string }) => unitIds.includes(r.unitId);
    const recordsOf = (personId: string) => ({
      ownerships: this.ownerships.filter((o) => o.personId === personId),
      tenancies: this.tenancies.filter((t) => t.occupants.some((o) => o.personId === personId)),
      household: this.household.filter((h) => h.personId === personId),
    });
    const relatedHere = (personId: string) => {
      const r = recordsOf(personId);
      return [...r.ownerships, ...r.tenancies, ...r.household].some(inProperty);
    };
    const unattached = (personId: string) => {
      const r = recordsOf(personId);
      return r.ownerships.length + r.tenancies.length + r.household.length === 0;
    };
    const person = (id: string | undefined) =>
      this.persons.find(
        (p) =>
          p.id === id &&
          p.organisationId === organisation.id &&
          p.status === 'ACTIVE' &&
          (relatedHere(p.id) || unattached(p.id)),
      );
    const dto = (p: FakePerson): PersonDto => {
      const { organisationId: _o, userId: _u, contacts: _c, ...rest } = p;
      return rest;
    };

    if (sub === '/residents') {
      const data: PropertyResidentDto[] = [];
      for (const p of this.persons.filter((x) => x.organisationId === organisation.id)) {
        const units = unitIds
          .map((unitId) => ({ unitId, roles: this.rolesOn([p.id], unitId) }))
          .filter((u) => u.roles.length > 0)
          .map((u) => ({
            ...u,
            unitNumber: this.units.find((x) => x.id === u.unitId)?.number ?? '',
          }));
        if (units.length > 0) data.push({ person: dto(p), units });
      }
      return this.reply(route, 200, { data });
    }
    if (sub === '/persons') {
      if (method === 'GET') {
        const query = (url.searchParams.get('query') ?? '').toLowerCase();
        const data = this.persons
          .filter((p) => person(p.id) && p.fullName.toLowerCase().includes(query))
          .sort((a, b) => a.fullName.localeCompare(b.fullName))
          .map(dto);
        return this.reply(route, 200, { data });
      }
      const fullName = str('fullName');
      if (!fullName) return invalid('fullName', 'Enter a name');
      const email = str('email')?.toLowerCase();
      const phone = str('phone');
      if (phone && !PHONE.test(phone)) return invalid('phone', 'Use international format');
      if (
        email &&
        this.persons.some((p) => p.organisationId === organisation.id && p.email === email)
      )
        return this.error(route, 409, 'PERSON_EMAIL_TAKEN');
      const created = this.addPerson(organisation.id, fullName, email ?? null);
      created.phone = phone ?? null;
      return this.reply(route, 201, dto(created));
    }
    const personMatch = /^\/persons\/([^/]+)(\/emergency-contacts(?:\/([^/]+))?)?$/.exec(sub);
    if (personMatch) {
      const p = person(personMatch[1]);
      if (!p) return this.error(route, 404, 'NOT_FOUND');
      if (personMatch[2]) {
        if (method === 'DELETE') {
          p.contacts = p.contacts.filter((c) => c.id !== personMatch[3]);
          return this.reply(route, 204);
        }
        const phone = str('phone') ?? '';
        if (!PHONE.test(phone)) return invalid('phone', 'Use international format');
        const contact: EmergencyContactDto = {
          id: randomUUID(),
          name: str('name') ?? '',
          phone,
          relationship: str('relationship') ?? null,
        };
        p.contacts.push(contact);
        return this.reply(route, 201, contact);
      }
      if (method === 'PATCH') {
        for (const key of ['fullName', 'email', 'phone', 'preferredLanguage'] as const) {
          if (body[key] === null && key !== 'fullName') p[key] = null;
          else if (typeof body[key] === 'string') p[key] = (body[key] as string).trim();
        }
        if (p.phone && !PHONE.test(p.phone)) return invalid('phone', 'Use international format');
        return this.reply(route, 200, dto(p));
      }
      const r = recordsOf(p.id);
      return this.reply(route, 200, {
        person: dto(p),
        ownerships: r.ownerships.filter(inProperty),
        tenancies: r.tenancies.filter(inProperty),
        household: r.household.filter(inProperty),
        emergencyContacts: p.contacts,
      });
    }

    if (sub === '/vehicles') {
      const rows = this.vehicles.filter((v) => v.propertyId === property.id);
      if (method === 'GET') {
        const status = url.searchParams.get('status') ?? 'ACTIVE';
        return this.reply(route, 200, {
          data: rows.filter((v) => v.status === status).map(({ propertyId: _p, ...v }) => v),
        });
      }
      const plate = (str('plate') ?? '').toUpperCase().replace(/\s+/g, '');
      if (!/^[A-Z0-9-]{2,15}$/.test(plate))
        return invalid('plate', 'Use letters, digits and hyphens');
      if (rows.some((v) => v.status === 'ACTIVE' && v.plate === plate))
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
      const { propertyId: _p, ...result } = vehicle;
      return this.reply(route, 201, result);
    }
    const vehicleArchive = /^\/vehicles\/([^/]+)\/archive$/.exec(sub);
    if (vehicleArchive) {
      const vehicle = this.vehicles.find(
        (v) => v.id === vehicleArchive[1] && v.propertyId === property.id,
      );
      if (!vehicle) return this.error(route, 404, 'NOT_FOUND');
      vehicle.status = 'ARCHIVED';
      const { propertyId: _p, ...result } = vehicle;
      return this.reply(route, 200, result);
    }

    const unitMatch = /^\/units\/([^/]+)\/([a-z]+)(?:\/([^/]+)\/(end))?$/.exec(sub);
    const unit = this.units.find((u) => u.id === unitMatch?.[1] && u.propertyId === property.id);
    if (!unitMatch || !unit) return this.error(route, 404, 'NOT_FOUND');
    if (method !== 'GET' && unit.status !== 'ACTIVE') return this.error(route, 409, 'ARCHIVED');
    const [, , section, recordId] = unitMatch;
    const date = (key: string) => {
      const value = str(key);
      return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
    };

    if (section === 'ownerships' && method === 'GET') {
      return this.reply(route, 200, { data: this.ownerships.filter((o) => o.unitId === unit.id) });
    }
    if (section === 'owners' && method === 'POST') {
      const effectiveFrom = date('effectiveFrom');
      if (!effectiveFrom) return invalid('effectiveFrom', 'Enter a date');
      const owners = (body.owners ?? []) as {
        personId: string;
        shareNumerator: number;
        shareDenominator: number;
      }[];
      if (owners.some((o) => !person(o.personId))) return invalid('owners', 'Choose each owner');
      if (new Set(owners.map((o) => o.personId)).size !== owners.length)
        return invalid('owners', 'Each person can appear once');
      if (!sharesSumToOne(owners))
        return invalid(
          'owners',
          'Shares must add up to exactly one (for example 1/2 + 1/2, or 1/3 + 2/3)',
        );
      const live = this.ownerships.filter((o) => o.unitId === unit.id && o.voidedAt === null);
      if (live.some((o) => o.effectiveFrom >= effectiveFrom))
        return this.error(route, 409, 'OWNERSHIP_CONFLICT');
      for (const o of live)
        if (o.effectiveTo === null || o.effectiveTo >= effectiveFrom)
          o.effectiveTo = dayBefore(effectiveFrom);
      for (const o of owners) {
        this.ownerships.push({
          id: randomUUID(),
          unitId: unit.id,
          personId: o.personId,
          fullName: person(o.personId)?.fullName ?? '',
          shareNumerator: o.shareNumerator,
          shareDenominator: o.shareDenominator,
          effectiveFrom,
          effectiveTo: null,
          voidedAt: null,
          voidReason: null,
        });
      }
      return this.reply(route, 200, { data: this.ownerships.filter((o) => o.unitId === unit.id) });
    }
    if (section === 'tenancies') {
      const rows = this.tenancies.filter((t) => t.unitId === unit.id);
      if (method === 'GET' && !recordId) return this.reply(route, 200, { data: rows });
      if (recordId) {
        const tenancy = rows.find((t) => t.id === recordId);
        if (!tenancy) return this.error(route, 404, 'NOT_FOUND');
        const endDate = date('endDate');
        if (!endDate) return invalid('endDate', 'Enter a date');
        if (endDate < tenancy.startDate) return this.error(route, 422, 'INVALID_PERIOD');
        tenancy.endDate = endDate;
        return this.reply(route, 200, tenancy);
      }
      const startDate = date('startDate');
      if (!startDate) return invalid('startDate', 'Enter a date');
      const endDate = date('endDate') ?? null;
      const occupants = (body.occupants ?? []) as { personId: string; isPrimary?: boolean }[];
      if (occupants.filter((o) => o.isPrimary).length !== 1)
        return invalid('occupants', 'Choose exactly one primary tenant');
      if (occupants.some((o) => !person(o.personId)))
        return invalid('occupants', 'Choose each tenant');
      if (
        rows.some(
          (t) => t.voidedAt === null && overlaps(t.startDate, t.endDate, startDate, endDate),
        )
      )
        return this.error(route, 409, 'TENANCY_OVERLAP');
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
          isPrimary: o.isPrimary === true,
        })),
      };
      this.tenancies.push(tenancy);
      return this.reply(route, 201, tenancy);
    }
    if (section === 'household') {
      const rows = this.household.filter((h) => h.unitId === unit.id);
      if (method === 'GET' && !recordId) return this.reply(route, 200, { data: rows });
      if (recordId) {
        const member = rows.find((h) => h.id === recordId);
        if (!member) return this.error(route, 404, 'NOT_FOUND');
        const endDate = date('endDate');
        if (!endDate) return invalid('endDate', 'Enter a date');
        if (endDate < member.validFrom) return this.error(route, 422, 'INVALID_PERIOD');
        member.validTo = endDate;
        return this.reply(route, 200, member);
      }
      const p = person(str('personId'));
      const validFrom = date('validFrom');
      if (!p) return invalid('personId', 'Choose a person');
      if (!validFrom) return invalid('validFrom', 'Enter a date');
      if (
        rows.some(
          (h) =>
            h.personId === p.id &&
            h.voidedAt === null &&
            overlaps(h.validFrom, h.validTo, validFrom, null),
        )
      )
        return this.error(route, 409, 'HOUSEHOLD_OVERLAP');
      const member: HouseholdMemberDto = {
        id: randomUUID(),
        unitId: unit.id,
        personId: p.id,
        fullName: p.fullName,
        relationship: str('relationship') ?? 'OTHER',
        validFrom,
        validTo: null,
        voidedAt: null,
      };
      this.household.push(member);
      return this.reply(route, 201, member);
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
