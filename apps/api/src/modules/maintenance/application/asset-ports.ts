import type { Trade } from '@veyra/domain';
import type { RequestMeta } from '../../../platform/request-meta';
import type { AssetStatus, IntervalUnit } from '../domain/asset-rules';
import type { Priority, WorkOrderStatus } from '../domain/maintenance-rules';

export interface AssetRecord {
  id: string;
  tag: string;
  name: string;
  category: Trade;
  unitId: string | null;
  unitNumber: string | null;
  commonAreaId: string | null;
  commonAreaName: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  installedOn: string | null;
  warrantyExpiresOn: string | null;
  supplierVendorId: string | null;
  supplierName: string | null;
  notes: string | null;
  status: AssetStatus;
  statusNote: string | null;
  retiredAt: Date | null;
  createdAt: Date;
}

export interface ScheduleRecord {
  id: string;
  assetId: string;
  title: string;
  description: string | null;
  priority: Priority;
  intervalUnit: IntervalUnit;
  intervalCount: number;
  nextDueOn: string;
  leadDays: number;
  vendorId: string | null;
  vendorName: string | null;
  active: boolean;
  createdAt: Date;
}

/** A work order on an asset, for its service history. */
export interface AssetWorkRecord {
  id: string;
  number: bigint;
  title: string;
  status: WorkOrderStatus;
  scheduledFor: string | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface AssetFields {
  name: string;
  category: Trade;
  unitId: string | null;
  commonAreaId: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  installedOn: string | null;
  warrantyExpiresOn: string | null;
  supplierVendorId: string | null;
  notes: string | null;
}

export interface ScheduleFields {
  title: string;
  description: string | null;
  priority: Priority;
  intervalUnit: IntervalUnit;
  intervalCount: number;
  nextDueOn: string;
  leadDays: number;
  vendorId: string | null;
  active: boolean;
}

/** One transaction in the organisation's RLS context, limited to one property. */
export interface AssetUnitOfWork {
  /** Today in the property's time zone (YYYY-MM-DD). */
  today(): Promise<string>;
  place(unitId: string | null, commonAreaId: string | null): Promise<boolean>;
  vendor(id: string): Promise<{ id: string; status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED' } | null>;
  assets(status?: AssetStatus): Promise<AssetRecord[]>;
  asset(id: string): Promise<AssetRecord | null>;
  tagTaken(tag: string): Promise<boolean>;
  createAsset(input: AssetFields & { tag: string }): Promise<string>;
  updateAsset(
    id: string,
    patch: Partial<AssetFields> & { status?: AssetStatus; statusNote?: string | null },
  ): Promise<void>;
  schedules(filter: { assetId?: string; activeOnly?: boolean }): Promise<ScheduleRecord[]>;
  schedule(id: string): Promise<ScheduleRecord | null>;
  createSchedule(input: ScheduleFields & { assetId: string }): Promise<string>;
  updateSchedule(id: string, patch: Partial<ScheduleFields>): Promise<void>;
  history(assetId: string): Promise<AssetWorkRecord[]>;
  /** Raises the preventive work order for a due date (numbered and logged by the database). */
  raiseWork(input: {
    asset: AssetRecord;
    schedule: ScheduleRecord;
    dueOn: string;
    vendorId: string | null;
  }): Promise<{ id: string; number: bigint }>;
  audit(event: {
    action: string;
    resourceType: 'asset' | 'maintenance_schedule' | 'work_order';
    resourceId: string;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<void>;
}

export interface AssetRepository {
  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: AssetUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export const ASSET_REPOSITORY = Symbol('ASSET_REPOSITORY');
