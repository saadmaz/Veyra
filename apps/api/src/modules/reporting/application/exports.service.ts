import { Inject, Injectable } from '@nestjs/common';
import { Money } from '@veyra/domain';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import type { OrganisationAccess, Permission } from '../../access-control';
import {
  EXPORTS,
  type ExportName,
  MAX_EXPORT_ROWS,
  MAX_RANGE_DAYS,
  type RangeInput,
  resolveRange,
  suppressed,
  toCsv,
} from '../domain/export-rules';
import { REPORTING_REPOSITORY, type ReportingRepository } from './reporting-ports';

/** The area each export belongs to: its read permission is needed as well as the export one. */
export const EXPORT_AREAS: Record<ExportName, Permission> = {
  'occupancy-by-building': 'property.structure.read',
  arrears: 'property.finance.read',
  'maintenance-requests': 'property.maintenance.read',
  visits: 'property.visitor.read',
  incidents: 'property.incident.read',
};

/** Exports with a date range (the others are as of today). */
const RANGED = new Set<ExportName>(['maintenance-requests', 'visits', 'incidents']);

export interface ExportFile {
  fileName: string;
  csv: string;
  rows: number;
}

/**
 * Exports (Phase 12 Part 2). CSV files of an area for holders of property.report.export and the
 * area's read permission. They carry no free text written by residents and no visitor names;
 * occupancy by building is suppressed for buildings with fewer than three units; every export is
 * recorded in the audit log with its size.
 */
@Injectable()
export class ExportsService {
  constructor(@Inject(REPORTING_REPOSITORY) private readonly repository: ReportingRepository) {}

  /** The exports the caller may download. */
  available(access: OrganisationAccess): ExportName[] {
    if (!access.permissions.has('property.report.export')) return [];
    return EXPORTS.filter((name) => access.permissions.has(EXPORT_AREAS[name]));
  }

  export(
    access: OrganisationAccess,
    name: ExportName,
    input: RangeInput,
    meta: RequestMeta,
  ): Promise<ExportFile> {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    if (!this.available(access).includes(name)) {
      throw new ApiError(403, 'FORBIDDEN', 'You cannot export this area');
    }
    const manager = access.permissions.has('property.incident.manage');
    return this.repository.inProperty(
      access.organisationId,
      access.propertyId,
      access.userId,
      meta,
      async (r) => {
        const today = await r.today();
        const property = await r.property();
        const range = resolveRange(input, today);
        if (!range) {
          throw new ApiError(
            422,
            'RANGE_TOO_LONG',
            `Export at most ${MAX_RANGE_DAYS} days at a time`,
          );
        }
        const at = (d: Date | null) => (d ? localTime(d, property.timeZone) : null);
        const money = (minor: bigint) => Money.ofMinor(minor, property.currency).toDecimalString();
        const limit = MAX_EXPORT_ROWS + 1;
        let header: string[];
        let rows: unknown[][];
        switch (name) {
          case 'occupancy-by-building': {
            header = ['building', 'units', 'tenanted', 'with_owner', 'note'];
            rows = (await r.occupancyByBuilding(today)).map((b) => [
              b.building ?? '(no building)',
              b.units,
              suppressed(b.units, b.tenanted),
              suppressed(b.units, b.withOwner),
              b.units < 3 ? 'too few units to show' : null,
            ]);
            break;
          }
          case 'arrears': {
            header = [
              'unit',
              `outstanding_${property.currency}`,
              `overdue_${property.currency}`,
              'oldest_unpaid_due',
            ];
            rows = (await r.arrears(today)).map((a) => [
              a.unit,
              money(a.outstandingMinor),
              money(a.overdueMinor),
              a.oldestDue,
            ]);
            break;
          }
          case 'maintenance-requests': {
            header = [
              'reference',
              'category',
              'priority',
              'status',
              'place',
              'created',
              'resolution_due',
              'resolved',
              'past_due',
            ];
            rows = (await r.maintenanceRequests(range, limit)).map((m) => [
              `MR-${String(m.number).padStart(6, '0')}`,
              m.category,
              m.priority,
              m.status,
              m.place,
              at(m.createdAt),
              at(m.resolutionDueAt),
              at(m.resolvedAt),
              m.overdue ? 'yes' : 'no',
            ]);
            break;
          }
          case 'visits': {
            header = ['arrived', 'departed', 'unit', 'category', 'decision', 'gate'];
            rows = (await r.visits(range, limit)).map((v) => [
              at(v.arrivedAt),
              at(v.departedAt),
              v.unit,
              v.category,
              v.decision,
              v.gate,
            ]);
            break;
          }
          case 'incidents': {
            header = [
              'reference',
              'category',
              'severity',
              'status',
              'occurred',
              'resolved',
              'closed',
            ];
            rows = (await r.incidentList(range, manager, limit)).map((i) => [
              `IN-${String(i.number).padStart(6, '0')}`,
              i.category,
              i.severity,
              i.status,
              at(i.occurredAt),
              at(i.resolvedAt),
              at(i.closedAt),
            ]);
            break;
          }
        }
        if (rows.length > MAX_EXPORT_ROWS) {
          throw new ApiError(
            422,
            'EXPORT_TOO_LARGE',
            `More than ${MAX_EXPORT_ROWS} rows: choose fewer days`,
          );
        }
        await r.audit({
          action: 'report.exported',
          metadata: {
            report: name,
            rows: rows.length,
            ...(RANGED.has(name) ? { from: range.from, to: range.to } : { asOf: today }),
          },
        });
        const dates = RANGED.has(name) ? `${range.from}_${range.to}` : today;
        return {
          fileName: `${property.code}-${name}-${dates}.csv`,
          csv: toCsv(header, rows),
          rows: rows.length,
        };
      },
    );
  }
}

/** "2026-11-12 14:05" in the property's time zone. */
function localTime(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}
