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
