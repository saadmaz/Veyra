import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { RequirePermission } from '../../src/modules/access-control';
import { RouteAccessVerifier } from '../../src/modules/access-control/presentation/route-access.verifier';
import { Authenticated, Public } from '../../src/platform/auth/route-access';

@Controller('ok')
class DeclaredController {
  @Get('public')
  @Public()
  open() {}

  @Get('me')
  @Authenticated()
  me() {}

  @Get(':organisationId/thing')
  @RequirePermission('organisation.profile.read')
  thing() {}
}

@Public()
@Controller('class-level')
class ClassLevelController {
  @Get()
  inherited() {}
}

@Controller('bad')
class UndeclaredController {
  @Get()
  forgotten() {}
}

@Controller('bad-scope')
class MissingOrganisationParamController {
  @Get('thing')
  @RequirePermission('organisation.profile.read')
  thing() {}
}

@Controller(':organisationId/bad-permission')
class UnknownPermissionController {
  @Get()
  @RequirePermission('organisation.everything.do' as never)
  thing() {}
}

@Controller(':organisationId/properties')
class MissingPropertyParamController {
  @Get()
  @RequirePermission('property.profile.read')
  list() {}
}

@Controller(':organisationId/properties/:propertyId')
class PropertyRouteController {
  @Get()
  @RequirePermission('property.profile.read')
  get() {}
}

@Controller(':organisationId/properties/:propertyId/units')
class MissingUnitParamController {
  @Get()
  @RequirePermission('unit.profile.read')
  list() {}
}

async function verify(...controllers: (new () => unknown)[]) {
  @Module({ imports: [DiscoveryModule], controllers, providers: [RouteAccessVerifier] })
  class TestModule {}
  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  try {
    await app.init();
  } finally {
    await app.close().catch(() => undefined);
  }
}

describe('route access check at startup', () => {
  it('accepts routes that declare their access, at method or class level', async () => {
    await expect(verify(DeclaredController, ClassLevelController)).resolves.toBeUndefined();
  });

  it('refuses to start when a route declares nothing', async () => {
    await expect(verify(DeclaredController, UndeclaredController)).rejects.toThrow(
      /UndeclaredController\.forgotten: no access declaration/,
    );
  });

  it('refuses permission routes without :organisationId in the path', async () => {
    await expect(verify(MissingOrganisationParamController)).rejects.toThrow(
      /without :organisationId/,
    );
  });

  it('requires :propertyId for property-scoped permissions', async () => {
    await expect(verify(PropertyRouteController)).resolves.toBeUndefined();
    await expect(verify(MissingPropertyParamController)).rejects.toThrow(
      /property permission without :propertyId/,
    );
  });

  it('requires :unitId for unit-scoped permissions', async () => {
    await expect(verify(MissingUnitParamController)).rejects.toThrow(
      /unit permission without :unitId/,
    );
  });

  it('refuses unknown permission strings', async () => {
    await expect(verify(UnknownPermissionController)).rejects.toThrow(/unknown permission/);
  });
});
