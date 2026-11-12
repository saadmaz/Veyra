import type { ExportName } from '@veyra/api-contracts';
import { API_BASE_URL, ApiRequestError, NETWORK_ERROR } from './api-client';

export const EXPORT_LABELS: Record<ExportName, { title: string; ranged: boolean }> = {
  'occupancy-by-building': { title: 'Occupancy by building', ranged: false },
  arrears: { title: 'Arrears by unit', ranged: false },
  'maintenance-requests': { title: 'Maintenance requests', ranged: true },
  visits: { title: 'Visits', ranged: true },
  incidents: { title: 'Incidents', ranged: true },
};

export const WEBHOOK_EVENT_LABELS: Record<string, string> = {
  'incident.reported': 'An incident is reported',
  'incident.closed': 'An incident is closed',
  'approval_request.created': 'Someone asks for an approval',
  'approval_request.settled': 'An approval request is approved or rejected',
  'webhook.test': 'Test',
};

/** The file name from a Content-Disposition header, or a fallback. */
export function fileNameFrom(disposition: string | null, fallback: string): string {
  const match = disposition ? /filename="([^"]+)"/.exec(disposition) : null;
  return match?.[1] ?? fallback;
}

/** Fetches a CSV export (with the session cookie) and returns it as a file to save. */
export async function fetchExport(
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ fileName: string; blob: Blob }> {
  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE_URL}${path}`, {
      credentials: 'include',
      headers: { Accept: 'text/csv' },
      cache: 'no-store',
    });
  } catch {
    throw new ApiRequestError(0, NETWORK_ERROR, 'The service could not be reached');
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      | { error?: { code?: string; message?: string } }
      | undefined;
    throw new ApiRequestError(
      response.status,
      payload?.error?.code ?? 'HTTP_ERROR',
      payload?.error?.message ?? `Request failed with status ${response.status}`,
    );
  }
  return {
    fileName: fileNameFrom(response.headers.get('content-disposition'), 'export.csv'),
    blob: await response.blob(),
  };
}

/** Hands a file to the browser to save. */
export function saveFile(file: { fileName: string; blob: Blob }) {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
