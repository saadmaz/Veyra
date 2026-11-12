import { Inject, Injectable } from '@nestjs/common';
import type { RequestMeta } from '../../../platform/request-meta';
import type { OrganisationAccess, Permission } from '../../access-control';
import {
  type FacilityFigures,
  type FinanceFigures,
  type IncidentFigures,
  type MaintenanceFigures,
  type OccupancyFigures,
  REPORTING_REPOSITORY,
  type ReportingRepository,
  type VisitorFigures,
} from './reporting-ports';

/** A property's dashboard; a section is null when the caller may not see that area. */
export interface PropertyDashboard {
  asOf: string;
  occupancy: OccupancyFigures | null;
  finance: FinanceFigures | null;
  maintenance: MaintenanceFigures | null;
  visitors: VisitorFigures | null;
  facilities: FacilityFigures | null;
  incidents: IncidentFigures | null;
  pendingApprovals: number | null;
}

/**
 * Reporting (Phase 12 Part 1). Role-scoped dashboards: every section is computed only when the
 * caller holds the read permission of that area at the property, so a dashboard never shows more
 * than the area's own screens would. Figures are counts and totals, never people.
 */
@Injectable()
export class ReportingService {
  constructor(@Inject(REPORTING_REPOSITORY) private readonly repository: ReportingRepository) {}

  dashboard(access: OrganisationAccess, meta: RequestMeta): Promise<PropertyDashboard> {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    const can = (p: Permission) => access.permissions.has(p);
    return this.repository.inProperty(
      access.organisationId,
      access.propertyId,
      access.userId,
      meta,
      async (r) => {
        const today = await r.today();
        return {
          asOf: today,
          occupancy: can('property.structure.read') ? await r.occupancy(today) : null,
          finance: can('property.finance.read') ? await r.finance(today) : null,
          maintenance: can('property.maintenance.read') ? await r.maintenance() : null,
          visitors: can('property.visitor.read') ? await r.visitors(today) : null,
          facilities: can('property.facility.read') ? await r.facilities() : null,
          incidents: can('property.incident.read')
            ? await r.incidents(can('property.incident.manage'))
            : null,
          pendingApprovals: can('property.approval.read') ? await r.pendingApprovals() : null,
        };
      },
    );
  }
}
