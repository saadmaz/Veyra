import type { RequestMeta } from '../../../platform/request-meta';

export interface OccupancyFigures {
  units: number;
  withOwner: number;
  tenanted: number;
}

export interface FinanceFigures {
  currency: string;
  outstandingMinor: bigint;
  overdueMinor: bigint;
  overdueInvoices: number;
  collectedLast30DaysMinor: bigint;
}

export interface MaintenanceFigures {
  openRequests: number;
  overdueRequests: number;
  openWorkOrders: number;
}

export interface VisitorFigures {
  arrivedToday: number;
  onSiteNow: number;
  last7Days: number;
}

export interface FacilityFigures {
  bookingsNext7Days: number;
  awaitingApproval: number;
}

export interface IncidentFigures {
  open: number;
  openHighOrCritical: number;
}

/** Read-only aggregates for one property, inside the organisation's RLS context. */
export interface ReportingReader {
  today(): Promise<string>;
  occupancy(today: string): Promise<OccupancyFigures>;
  finance(today: string): Promise<FinanceFigures>;
  maintenance(): Promise<MaintenanceFigures>;
  visitors(today: string): Promise<VisitorFigures>;
  facilities(): Promise<FacilityFigures>;
  /** Sensitive incidents count only for people who may see them. */
  incidents(includeSensitive: boolean): Promise<IncidentFigures>;
  pendingApprovals(): Promise<number>;

  // Exports (Part 2). Dates are the property's local dates, inclusive.
  property(): Promise<{ code: string; currency: string; timeZone: string }>;
  occupancyByBuilding(
    today: string,
  ): Promise<{ building: string | null; units: number; tenanted: number; withOwner: number }[]>;
  arrears(
    today: string,
  ): Promise<{ unit: string; outstandingMinor: bigint; overdueMinor: bigint; oldestDue: string }[]>;
  maintenanceRequests(
    range: DateRange,
    limit: number,
  ): Promise<
    {
      number: number;
      category: string;
      priority: string;
      status: string;
      place: string | null;
      createdAt: Date;
      resolutionDueAt: Date | null;
      resolvedAt: Date | null;
      overdue: boolean;
    }[]
  >;
  visits(
    range: DateRange,
    limit: number,
  ): Promise<
    {
      arrivedAt: Date;
      departedAt: Date | null;
      unit: string | null;
      category: string;
      decision: string;
      gate: string | null;
    }[]
  >;
  incidentList(
    range: DateRange,
    includeSensitive: boolean,
    limit: number,
  ): Promise<
    {
      number: number;
      category: string;
      severity: string;
      status: string;
      occurredAt: Date;
      resolvedAt: Date | null;
      closedAt: Date | null;
    }[]
  >;
  audit(event: {
    action: string;
    metadata: Record<string, string | number | boolean>;
  }): Promise<void>;
}

export interface DateRange {
  from: string;
  to: string;
}

export interface ReportingRepository {
  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (reader: ReportingReader) => Promise<T>,
  ): Promise<T>;
}

export const REPORTING_REPOSITORY = Symbol('REPORTING_REPOSITORY');
