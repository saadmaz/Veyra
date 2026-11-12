import type {
  AttachmentContentType,
  AttachmentUploadDto,
  MaintenanceAttachmentDto,
  MaintenanceCategory,
  MaintenanceEventDto,
  MaintenancePriority,
  MaintenanceRequestDto,
  MaintenanceRequestStatus,
  WorkOrderStatus,
} from '@veyra/api-contracts';
import { ApiRequestError, api } from './api-client';

/*
 * Maintenance helpers for the console (Phase 7). The API decides who may do what and checks
 * every upload; these only shape what is shown.
 */

export const CATEGORY_LABELS: Record<MaintenanceCategory, string> = {
  PLUMBING: 'Plumbing',
  ELECTRICAL: 'Electrical',
  HVAC: 'Heating and air conditioning',
  APPLIANCE: 'Appliance',
  STRUCTURAL: 'Walls, floors and ceilings',
  CARPENTRY: 'Doors, windows and woodwork',
  PAINTING: 'Painting',
  PEST_CONTROL: 'Pests',
  CLEANING: 'Cleaning',
  LIFT: 'Lift',
  SECURITY_SYSTEM: 'Locks, alarms and intercom',
  OTHER: 'Something else',
};
export const CATEGORIES = Object.keys(CATEGORY_LABELS) as MaintenanceCategory[];

export const PRIORITY_LABELS: Record<MaintenancePriority, string> = {
  URGENT: 'Urgent',
  HIGH: 'High',
  MEDIUM: 'Normal',
  LOW: 'Low',
};
export const PRIORITIES: MaintenancePriority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];

export const REQUEST_STATUS_LABELS: Record<MaintenanceRequestStatus, string> = {
  SUBMITTED: 'new',
  ACCEPTED: 'in hand',
  RESOLVED: 'done, to confirm',
  CLOSED: 'closed',
  REJECTED: 'declined',
  CANCELLED: 'cancelled',
};

export const REQUEST_STATUS_TONES: Record<
  MaintenanceRequestStatus,
  'success' | 'warning' | 'muted' | 'danger'
> = {
  SUBMITTED: 'warning',
  ACCEPTED: 'warning',
  RESOLVED: 'success',
  CLOSED: 'muted',
  REJECTED: 'danger',
  CANCELLED: 'muted',
};

export const WORK_STATUS_LABELS: Record<WorkOrderStatus, string> = {
  OPEN: 'not assigned',
  ASSIGNED: 'assigned',
  IN_PROGRESS: 'in progress',
  ON_HOLD: 'on hold',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

export const WORK_STATUS_TONES: Record<
  WorkOrderStatus,
  'success' | 'warning' | 'muted' | 'danger'
> = {
  OPEN: 'warning',
  ASSIGNED: 'muted',
  IN_PROGRESS: 'warning',
  ON_HOLD: 'danger',
  COMPLETED: 'success',
  CANCELLED: 'muted',
};

/** Where: "Unit 101" or the common area's name, with the detail given. */
export function placeText(r: {
  unitNumber: string | null;
  commonAreaName: string | null;
  locationDetail?: string | null;
}): string {
  const place = r.unitNumber ? `Unit ${r.unitNumber}` : (r.commonAreaName ?? '—');
  return r.locationDetail ? `${place} · ${r.locationDetail}` : place;
}

/** Whether a request is past a target it has not met (computed by the API). */
export const isOverdue = (r: Pick<MaintenanceRequestDto, 'overdue'>) =>
  r.overdue.response || r.overdue.resolution;

/** One line for a history event, as residents and staff read it. */
export function eventText(e: MaintenanceEventDto, names: (userId: string) => string): string {
  const who = e.actor?.name ?? 'VEYRA';
  switch (e.type) {
    case 'STATUS_CHANGED': {
      const to = e.to as string;
      const label =
        to in REQUEST_STATUS_LABELS
          ? REQUEST_STATUS_LABELS[to as MaintenanceRequestStatus]
          : WORK_STATUS_LABELS[to as WorkOrderStatus];
      const subject = e.workOrderNumber ? `Work ${e.workOrderNumber}` : 'Request';
      return e.from === null ? `${subject} created by ${who}` : `${subject} ${label} (${who})`;
    }
    case 'PRIORITY_CHANGED':
      return `Priority changed to ${PRIORITY_LABELS[e.to as MaintenancePriority] ?? e.to} by ${who}`;
    case 'ASSIGNEE_CHANGED':
      return e.to
        ? `Work ${e.workOrderNumber ?? ''} assigned to ${names(e.to)}`.replace('  ', ' ')
        : `Work ${e.workOrderNumber ?? ''} unassigned`.replace('  ', ' ');
    case 'VENDOR_CHANGED':
      return e.to
        ? `Work ${e.workOrderNumber ?? ''} given to a vendor by ${who}`.replace('  ', ' ')
        : `Vendor taken off work ${e.workOrderNumber ?? ''} by ${who}`.trim();
    case 'SLA_BREACHED':
      return e.to === 'RESPONSE' ? 'Response target missed' : 'Resolution target missed';
    default:
      return `${who} wrote`;
  }
}

/** "in 3 h", "2 d ago": how far a due time is from now. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  const abs = Math.abs(minutes);
  const amount =
    abs < 60
      ? `${abs} min`
      : abs < 48 * 60
        ? `${Math.round(abs / 60)} h`
        : `${Math.round(abs / 1440)} d`;
  return minutes >= 0 ? `in ${amount}` : `${amount} ago`;
}

export const ACCEPTED_FILE_TYPES: AttachmentContentType[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** A problem with a chosen file before anything is sent, or null when it can be uploaded. */
export function fileProblem(file: { type: string; size: number }): string | null {
  if (!(ACCEPTED_FILE_TYPES as string[]).includes(file.type)) {
    return 'Choose a photo (JPEG, PNG, WebP or HEIC) or a PDF.';
  }
  if (file.size === 0) return 'This file is empty.';
  if (file.size > MAX_FILE_BYTES) return 'Files can be at most 10 MB.';
  return null;
}

export const formatBytes = (n: number) =>
  n < 1024 * 1024
    ? `${Math.max(1, Math.round(n / 1024))} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * Uploads a file the way the API asks (ADR 0007): ask for a signed URL, PUT the bytes straight to
 * storage, then let the API check them. `base` is the attachments path of a request or work order.
 */
export async function uploadFile(
  base: string,
  file: File,
  extra: { kind?: 'BEFORE' | 'AFTER' | 'OTHER'; visibility?: 'RESIDENT' | 'INTERNAL' } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<MaintenanceAttachmentDto> {
  const asked = await api.post<AttachmentUploadDto>(base, {
    fileName: file.name,
    contentType: file.type,
    sizeBytes: file.size,
    ...extra,
  });
  let stored: Response;
  try {
    stored = await fetchImpl(asked.upload.url, {
      method: 'PUT',
      headers: asked.upload.headers,
      body: file,
    });
  } catch {
    throw new ApiRequestError(0, 'UPLOAD_FAILED', 'The file could not be uploaded');
  }
  if (!stored.ok) throw new ApiRequestError(stored.status, 'UPLOAD_FAILED', 'Upload refused');
  return api.post<MaintenanceAttachmentDto>(`${base}/${asked.attachmentId}/complete`);
}
