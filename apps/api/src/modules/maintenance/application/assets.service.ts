import { Inject, Injectable } from '@nestjs/common';
import { databaseErrorCode } from '@veyra/db';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import type { OrganisationAccess } from '../../access-control';
import {
  type AssetStatus,
  type CreateAssetInput,
  type CreateScheduleInput,
  isDue,
  nextDueAfter,
  type UpdateAssetInput,
  type UpdateScheduleInput,
} from '../domain/asset-rules';
import { formatWorkOrderNumber } from '../domain/maintenance-rules';
import {
  ASSET_REPOSITORY,
  type AssetFields,
  type AssetRepository,
  type AssetUnitOfWork,
} from './asset-ports';

const assetNotFound = () => new ApiError(404, 'NOT_FOUND', 'Asset not found');
const invalidState = (message: string) => new ApiError(409, 'INVALID_STATE_TRANSITION', message);
const retired = () => new ApiError(409, 'RETIRED', 'This asset is retired');

/**
 * Assets and preventive maintenance (Phase 9 Part 2): the property's asset register, schedules of
 * repeating work, and raising the work orders that are due. Read with property.maintenance.read,
 * change with property.maintenance.manage. Preventive work goes to the schedule's vendor while it
 * is active, otherwise to the open pool.
 */
@Injectable()
export class AssetsService {
  constructor(@Inject(ASSET_REPOSITORY) private readonly repository: AssetRepository) {}

  list(access: OrganisationAccess, status: AssetStatus | undefined, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => ({
      assets: await uow.assets(status),
      today: await uow.today(),
    }));
  }

  detail(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, (uow) => this.view(uow, id));
  }

  create(access: OrganisationAccess, input: CreateAssetInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      if (await uow.tagTaken(input.tag)) {
        throw new ApiError(409, 'TAG_TAKEN', 'Another asset of this property has this tag');
      }
      const place = { unitId: input.unitId ?? null, commonAreaId: input.commonAreaId ?? null };
      await this.requirePlace(uow, place.unitId, place.commonAreaId);
      if (input.supplierVendorId) await this.requireVendor(uow, input.supplierVendorId, false);
      const id = await uow.createAsset({
        tag: input.tag,
        name: input.name,
        category: input.category,
        ...place,
        manufacturer: input.manufacturer ?? null,
        model: input.model ?? null,
        serialNumber: input.serialNumber ?? null,
        installedOn: input.installedOn ?? null,
        warrantyExpiresOn: input.warrantyExpiresOn ?? null,
        supplierVendorId: input.supplierVendorId ?? null,
        notes: input.notes ?? null,
      });
      await uow.audit({ action: 'asset.created', resourceType: 'asset', resourceId: id });
      return this.view(uow, id);
    });
  }

  update(access: OrganisationAccess, id: string, input: UpdateAssetInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const asset = await this.mustFind(uow, id);
      if (asset.status === 'RETIRED') throw retired();
      const patch: Partial<AssetFields> = Object.fromEntries(
        Object.entries(input).filter(([, v]) => v !== undefined),
      );
      if (input.unitId || input.commonAreaId) {
        patch.unitId = input.unitId ?? null;
        patch.commonAreaId = input.commonAreaId ?? null;
        await this.requirePlace(uow, patch.unitId, patch.commonAreaId);
      }
      if (input.supplierVendorId) await this.requireVendor(uow, input.supplierVendorId, false);
      await uow.updateAsset(id, patch);
      await uow.audit({
        action: 'asset.updated',
        resourceType: 'asset',
        resourceId: id,
        metadata: { fields: Object.keys(patch).join(',') },
      });
      return this.view(uow, id);
    });
  }

  /** Out of service (with a reason), back in service, or retired for good. */
  setStatus(
    access: OrganisationAccess,
    id: string,
    status: AssetStatus,
    reason: string | null,
    meta: RequestMeta,
  ) {
    return this.run(access, meta, async (uow) => {
      const asset = await this.mustFind(uow, id);
      if (asset.status === 'RETIRED') throw retired();
      if (asset.status === status)
        throw invalidState(`The asset is already ${status.toLowerCase().replace(/_/g, ' ')}`);
      if (status === 'RETIRED') {
        if ((await uow.schedules({ assetId: id, activeOnly: true })).length > 0) {
          throw invalidState('Pause the schedules of this asset before retiring it');
        }
        if (
          (await uow.history(id)).some((w) => w.status !== 'COMPLETED' && w.status !== 'CANCELLED')
        ) {
          throw invalidState('Finish or cancel the open work on this asset before retiring it');
        }
      }
      await uow.updateAsset(id, { status, statusNote: status === 'ACTIVE' ? null : reason });
      await uow.audit({
        action: `asset.${status.toLowerCase()}`,
        resourceType: 'asset',
        resourceId: id,
      });
      return this.view(uow, id);
    });
  }

  addSchedule(
    access: OrganisationAccess,
    assetId: string,
    input: CreateScheduleInput,
    meta: RequestMeta,
  ) {
    return this.run(access, meta, async (uow) => {
      const asset = await this.mustFind(uow, assetId);
      if (asset.status === 'RETIRED') throw retired();
      if (input.vendorId) await this.requireVendor(uow, input.vendorId, false);
      const id = await uow.createSchedule({
        assetId,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority,
        intervalUnit: input.intervalUnit,
        intervalCount: input.intervalCount,
        nextDueOn: input.nextDueOn,
        leadDays: input.leadDays,
        vendorId: input.vendorId ?? null,
        active: true,
      });
      await uow.audit({
        action: 'maintenance_schedule.created',
        resourceType: 'maintenance_schedule',
        resourceId: id,
      });
      return this.view(uow, assetId);
    });
  }

  updateSchedule(
    access: OrganisationAccess,
    id: string,
    input: UpdateScheduleInput,
    meta: RequestMeta,
  ) {
    return this.run(access, meta, async (uow) => {
      const schedule = await uow.schedule(id);
      if (!schedule) throw new ApiError(404, 'NOT_FOUND', 'Schedule not found');
      const asset = await this.mustFind(uow, schedule.assetId);
      if (asset.status === 'RETIRED' && input.active) throw retired();
      if (input.vendorId) await this.requireVendor(uow, input.vendorId, false);
      const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      await uow.updateSchedule(id, patch);
      await uow.audit({
        action: 'maintenance_schedule.updated',
        resourceType: 'maintenance_schedule',
        resourceId: id,
        metadata: { fields: Object.keys(patch).join(',') },
      });
      return this.view(uow, schedule.assetId);
    });
  }

  /** Active schedules of the property, soonest due first, with their asset. */
  schedules(access: OrganisationAccess, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const [schedules, assets, today] = await Promise.all([
        uow.schedules({ activeOnly: true }),
        uow.assets(),
        uow.today(),
      ]);
      const byId = new Map(assets.map((a) => [a.id, a]));
      return {
        today,
        schedules: schedules.map((s) => ({
          schedule: s,
          asset: byId.get(s.assetId) ?? null,
          due: isDue(s.nextDueOn, s.leadDays, today),
        })),
      };
    });
  }

  /**
   * Raises the work that is due: one work order per active schedule whose next date is within its
   * lead time (or past), on assets in use. The next date then moves on by the interval, past
   * today, so missed periods are skipped rather than raised all at once. Safe to run again: a
   * schedule raises one work order per date (database unique key).
   */
  raiseDue(access: OrganisationAccess, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const today = await uow.today();
      const raised: {
        workOrderId: string;
        number: string;
        assetTag: string;
        scheduledFor: string;
      }[] = [];
      const skipped: { scheduleId: string; reason: string }[] = [];
      for (const schedule of await uow.schedules({ activeOnly: true })) {
        if (!isDue(schedule.nextDueOn, schedule.leadDays, today)) continue;
        const asset = await uow.asset(schedule.assetId);
        if (asset?.status !== 'ACTIVE') {
          skipped.push({ scheduleId: schedule.id, reason: 'The asset is out of service' });
          continue;
        }
        const vendor = schedule.vendorId ? await uow.vendor(schedule.vendorId) : null;
        const work = await uow.raiseWork({
          asset,
          schedule,
          dueOn: schedule.nextDueOn,
          vendorId: vendor?.status === 'ACTIVE' ? vendor.id : null,
        });
        await uow.updateSchedule(schedule.id, {
          nextDueOn: nextDueAfter(
            schedule.nextDueOn,
            schedule.intervalUnit,
            schedule.intervalCount,
            today,
          ),
        });
        await uow.audit({
          action: 'work_order.raised_by_schedule',
          resourceType: 'work_order',
          resourceId: work.id,
          metadata: {
            scheduleId: schedule.id,
            assetId: asset.id,
            scheduledFor: schedule.nextDueOn,
          },
        });
        raised.push({
          workOrderId: work.id,
          number: formatWorkOrderNumber(work.number),
          assetTag: asset.tag,
          scheduledFor: schedule.nextDueOn,
        });
      }
      return { raised, skipped };
    });
  }

  // ------------------------------------------------------------------ shared

  private async view(uow: AssetUnitOfWork, id: string) {
    const asset = await this.mustFind(uow, id);
    const [schedules, history, today] = await Promise.all([
      uow.schedules({ assetId: id }),
      uow.history(id),
      uow.today(),
    ]);
    return { asset, schedules, history, today };
  }

  private async mustFind(uow: AssetUnitOfWork, id: string) {
    const asset = await uow.asset(id);
    if (!asset) throw assetNotFound();
    return asset;
  }

  private async requirePlace(
    uow: AssetUnitOfWork,
    unitId: string | null,
    commonAreaId: string | null,
  ) {
    if (!(await uow.place(unitId, commonAreaId))) {
      throw new ApiError(
        422,
        'VALIDATION_FAILED',
        'Choose an active unit or common area of this property',
      );
    }
  }

  private async requireVendor(uow: AssetUnitOfWork, id: string, activeOnly: boolean) {
    const vendor = await uow.vendor(id);
    if (!vendor) throw new ApiError(404, 'NOT_FOUND', 'Vendor not found');
    if (vendor.status === 'ARCHIVED' || (activeOnly && vendor.status !== 'ACTIVE')) {
      throw new ApiError(409, 'VENDOR_NOT_ACTIVE', 'This vendor is archived');
    }
  }

  private async run<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: AssetUnitOfWork) => Promise<T>,
  ): Promise<T> {
    const { propertyId } = access;
    if (!propertyId) throw new Error('Property route without a resolved property');
    try {
      return await this.repository.inProperty(
        access.organisationId,
        propertyId,
        access.userId,
        meta,
        work,
      );
    } catch (error) {
      const code = databaseErrorCode(error);
      if (code === '23505') {
        throw new ApiError(
          409,
          'CONFLICT',
          'This changed at the same time elsewhere. Reload and try again.',
        );
      }
      if (code === '23514')
        throw invalidState('This change is not possible any more. Reload and try again.');
      throw error;
    }
  }
}
