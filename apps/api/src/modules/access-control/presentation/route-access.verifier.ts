import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { ROUTE_ACCESS, type RouteAccess } from '../../../platform/auth/route-access';
import { isPermission } from '../domain/permissions';
import { ORGANISATION_ID_PARAM } from './require-permission.decorator';

const toArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : value === undefined ? [''] : [String(value)];

/**
 * Startup check (ACCESS_CONTROL section 3): every route must declare @Public(),
 * @Authenticated() or @RequirePermission(). Permission routes must name a registered
 * permission and take :organisationId from the path. Any violation stops the application from
 * starting, listing the offending routes.
 */
@Injectable()
export class RouteAccessVerifier implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onApplicationBootstrap(): void {
    const problems = this.findProblems();
    if (problems.length > 0) {
      throw new Error(
        `Route access check failed. Every route needs @Public(), @Authenticated() or @RequirePermission():\n${problems
          .map((p) => `  - ${p}`)
          .join('\n')}`,
      );
    }
  }

  findProblems(): string[] {
    const problems: string[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const controller = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
      const prototype = wrapper.instance ? Object.getPrototypeOf(wrapper.instance) : undefined;
      if (!controller || !prototype) continue;
      const controllerPaths = toArray(Reflect.getMetadata(PATH_METADATA, controller));
      const classAccess = Reflect.getMetadata(ROUTE_ACCESS, controller) as RouteAccess | undefined;

      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[methodName] as object;
        const methodPath = Reflect.getMetadata(PATH_METADATA, handler);
        if (methodPath === undefined) continue; // not a route handler
        const name = `${controller.name}.${methodName}`;
        const access =
          (Reflect.getMetadata(ROUTE_ACCESS, handler) as RouteAccess | undefined) ?? classAccess;

        if (!access) {
          problems.push(`${name}: no access declaration`);
          continue;
        }
        if (access.kind !== 'permission') continue;
        if (!isPermission(access.permission)) {
          problems.push(`${name}: unknown permission "${access.permission}"`);
        }
        const paths = controllerPaths.flatMap((c) => toArray(methodPath).map((m) => `${c}/${m}`));
        if (!paths.every((path) => path.includes(`:${ORGANISATION_ID_PARAM}`))) {
          problems.push(`${name}: permission route without :${ORGANISATION_ID_PARAM} in its path`);
        }
      }
    }
    return problems;
  }
}
