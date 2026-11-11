'use client';

import type {
  GatePassView,
  Paginated,
  PropertyDetailResponse,
  UnitDto,
  ValidatePassResponse,
  VisitDto,
  WalkInRequestDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { canScanQr, QrScanner } from '@/components/qr-scanner';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
} from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import { enumLabel, errorMessage, fieldErrors } from '@/lib/messages';
import { checkOffline, hashCode, hashToken, queuedAdmissionsByPass } from '@/lib/offline-gate';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';
import {
  isNetworkError,
  type OfflineGate,
  useConnection,
  useOfflineGate,
} from '@/lib/use-offline-gate';
import { usePolling } from '@/lib/use-polling';
import {
  formatTime,
  REJECTION_MESSAGES,
  secondsUntil,
  VISITOR_CATEGORIES,
  WALK_IN_STATUS_LABELS,
} from '@/lib/visitors';

/** The gate name is a per-device convenience; the page works without it. */
const GATE_KEY = 'veyra.gate';
const readGate = () => {
  try {
    return window.localStorage.getItem(GATE_KEY) ?? '';
  } catch {
    return '';
  }
};
const saveGate = (value: string) => {
  try {
    window.localStorage.setItem(GATE_KEY, value);
  } catch {
    // Storage blocked (private window): the gate name is simply not remembered.
  }
};

/**
 * The gate screen for security staff (Operations, phone-first). Check a pass, admit or refuse,
 * ask residents to approve walk-ins, record departures. Guards see only what they need.
 */
export default function GatePage() {
  const { organisationId, propertyId } = useParams<{
    organisationId: string;
    propertyId: string;
  }>();
  const base = `/organisations/${organisationId}/properties/${propertyId}`;
  const property = useApiQuery<PropertyDetailResponse>(base);
  const [gate, setGate] = useState('');
  useEffect(() => setGate(readGate()), []);
  // Bumped after every admission so "Inside now" shows the visitor at once.
  const [admissions, setAdmissions] = useState(0);
  const onAdmitted = useCallback(() => setAdmissions((n) => n + 1), []);
  const { online, markOffline } = useConnection();
  const offline = useOfflineGate(propertyId, base, online);

  useEffect(() => {
    if (property.status === 'success') document.title = `Gate · ${property.data.name} · VEYRA`;
  }, [property]);

  if (property.status === 'loading') return <LoadingState label="Loading the gate" />;
  if (property.status === 'error') {
    if (property.error instanceof ApiRequestError && property.error.status === 404) {
      return (
        <EmptyState title="Property not found">
          It does not exist, or it is not one of the properties assigned to you.
        </EmptyState>
      );
    }
    return <ErrorState error={property.error} onRetry={property.reload} />;
  }
  const p = property.data;
  const header = (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href={base}>{p.name}</Link>
      </nav>
      <div className="page__header">
        <h1>Gate</h1>
      </div>
    </>
  );
  if (!p.permissions.includes('property.visitor.check_in')) {
    return (
      <>
        {header}
        <EmptyState title="You cannot operate the gate">
          The gate screen is for security staff and property managers.
        </EmptyState>
      </>
    );
  }

  const shared = {
    base,
    propertyId,
    gate: gate.trim() || undefined,
    timeZone: p.timeZone,
    onAdmitted,
    online,
    markOffline,
    offline,
  };
  return (
    <>
      {header}
      <OfflineStatus online={online} offline={offline} timeZone={p.timeZone} />
      <TextField
        label="This gate"
        name="gate"
        maxLength={60}
        value={gate}
        className="gate__name"
        hint="Recorded with each entry, e.g. Main gate. Remembered on this device."
        onChange={(event) => {
          setGate(event.target.value);
          saveGate(event.target.value);
        }}
      />
      <CheckPass {...shared} />
      <WalkIns {...shared} />
      <Inside {...shared} admissions={admissions} />
    </>
  );
}

interface GateProps {
  base: string;
  propertyId: string;
  gate: string | undefined;
  timeZone: string;
  onAdmitted: () => void;
  online: boolean;
  markOffline: () => void;
  offline: OfflineGate;
}

/**
 * What the guard needs to know about the connection: offline, the list in use and how long it may
 * be trusted, entries waiting to be sent, and the outcome of the last send.
 */
function OfflineStatus({
  online,
  offline,
  timeZone,
}: {
  online: boolean;
  offline: OfflineGate;
  timeZone: string;
}) {
  const waiting = offline.queue.length;
  const list = offline.list;
  const trusted = list && Date.parse(list.trustUntil) > Date.now();
  const sync = offline.lastSync;
  return (
    <div role="status" aria-live="polite">
      {!online ? (
        <Alert tone="info" title="No connection">
          {trusted ? (
            <p>
              Passes are checked against the list saved at {formatTime(list.generatedAt, timeZone)},
              usable until {formatTime(list.trustUntil, timeZone)}. Recent cancellations may be
              missing: check identity carefully. Entries are kept on this device and sent when the
              connection returns.
            </p>
          ) : (
            <p>
              There is no usable offline list on this device. Follow the paper procedure: write each
              entry in the gate log.
            </p>
          )}
        </Alert>
      ) : null}
      {waiting > 0 ? (
        <Alert tone="info">
          {waiting} {waiting === 1 ? 'entry is' : 'entries are'} waiting to be sent.
        </Alert>
      ) : null}
      {sync && (sync.recorded > 0 || sync.failed.length > 0) ? (
        <Alert tone={sync.failed.length > 0 ? 'danger' : 'success'} title="Offline entries sent">
          <p>
            {sync.recorded} recorded
            {sync.flagged.length > 0
              ? `; ${sync.flagged.length} will be reviewed by a supervisor`
              : ''}
            .
          </p>
          {sync.failed.length > 0 ? (
            <p>
              Not recorded, write these in the paper log:{' '}
              {sync.failed.map((f) => f.label).join('; ')}.
            </p>
          ) : null}
        </Alert>
      ) : null}
    </div>
  );
}

const OFFLINE_REJECTIONS: Record<string, string> = {
  ...REJECTION_MESSAGES,
  LIST_EXPIRED:
    'The offline list is more than 4 hours old and can no longer be trusted. Follow the paper procedure.',
  NO_LIST: 'There is no offline list on this device. Follow the paper procedure.',
};

type CheckResult =
  | { valid: true; pass: GatePassView; offline: boolean }
  | { valid: false; reason: string; offline: boolean };

function CheckPass({
  base,
  propertyId,
  gate,
  timeZone,
  onAdmitted,
  online,
  markOffline,
  offline,
}: GateProps) {
  const check = useAction();
  const decide = useAction();
  const [result, setResult] = useState<CheckResult | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [refusing, setRefusing] = useState(false);
  const [scanSupported, setScanSupported] = useState(false);
  useEffect(() => setScanSupported(canScanQr()), []);

  const { list, queue, enqueue } = offline;
  const checkWithoutConnection = useCallback(
    async (body: { token?: string; code?: string }) => {
      const match = body.token
        ? { tokenHash: await hashToken(body.token) }
        : { codeHash: await hashCode(propertyId, body.code ?? '') };
      const outcome = checkOffline(list, match, queuedAdmissionsByPass(queue));
      setResult(
        outcome.valid
          ? {
              valid: true,
              offline: true,
              pass: {
                invitationId: outcome.entry.invitationId,
                passId: outcome.entry.passId,
                category: outcome.entry.category,
                visitorName: outcome.entry.visitorName,
                vehiclePlate: outcome.entry.vehiclePlate,
                unitNumber: outcome.entry.unitNumber,
                validUntil: outcome.entry.validUntil,
                entriesLeft: outcome.entry.entriesLeft,
              },
            }
          : { valid: false, offline: true, reason: outcome.reason },
      );
    },
    [propertyId, list, queue],
  );

  const validate = useCallback(
    async (body: { token?: string; code?: string }) => {
      setDone(null);
      setResult(null);
      setRefusing(false);
      if (!online) return checkWithoutConnection(body);
      let response: ValidatePassResponse | undefined;
      let unreachable = false;
      const ok = await check.run(async () => {
        try {
          response = await api.post<ValidatePassResponse>(`${base}/gate/validate`, {
            ...body,
            gate,
          });
        } catch (error) {
          if (!isNetworkError(error)) throw error;
          unreachable = true;
        }
      });
      if (unreachable) {
        markOffline();
        return checkWithoutConnection(body);
      }
      if (ok && response) setResult({ ...response, offline: false });
    },
    [base, gate, online, markOffline, checkWithoutConnection, check.run],
  );
  const onToken = useCallback(
    (token: string) => {
      setScanning(false);
      void validate({ token });
    },
    [validate],
  );

  const pass = result?.valid ? result.pass : null;
  return (
    <Card title="Check a pass">
      <form
        className="form form--inline"
        noValidate
        aria-label="Check a reference code"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void validate({ code: String(new FormData(event.currentTarget).get('code') ?? '') });
        }}
      >
        {check.error ? <Alert>{errorMessage(check.error)}</Alert> : null}
        <TextField
          label="Reference code"
          name="code"
          required
          maxLength={20}
          autoComplete="off"
          autoCapitalize="characters"
          hint="8 letters and digits, e.g. K7Q2-M9XA"
          error={fieldErrors(check.error).code}
        />
        <div className="form__actions">
          <Button type="submit" busy={check.busy}>
            Check code
          </Button>
          {scanSupported ? (
            <Button variant="secondary" onClick={() => setScanning(true)}>
              Scan QR code
            </Button>
          ) : null}
        </div>
      </form>
      {scanning ? <QrScanner onToken={onToken} onClose={() => setScanning(false)} /> : null}

      {result && !result.valid ? (
        <Alert title="Do not admit on this pass">
          {OFFLINE_REJECTIONS[result.reason] ?? result.reason}
        </Alert>
      ) : null}
      {pass ? (
        <Alert tone="success" title={result?.offline ? 'Valid pass (offline check)' : 'Valid pass'}>
          <dl className="details">
            <div>
              <dt>Visitor</dt>
              <dd>{pass.visitorName}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{enumLabel(pass.category)}</dd>
            </div>
            <div>
              <dt>Unit</dt>
              <dd>{pass.unitNumber}</dd>
            </div>
            <div>
              <dt>Vehicle</dt>
              <dd>{pass.vehiclePlate ?? '—'}</dd>
            </div>
            <div>
              <dt>Valid until</dt>
              <dd>{formatTime(pass.validUntil, timeZone)}</dd>
            </div>
          </dl>
          <p>
            Check that the person matches before letting them in. A pass is not proof of identity.
          </p>
          {decide.error ? <Alert>{errorMessage(decide.error)}</Alert> : null}
          {refusing ? (
            <form
              className="form form--inline"
              noValidate
              aria-label="Refuse entry"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const reason = String(new FormData(event.currentTarget).get('reason') ?? '');
                if (result?.offline) {
                  enqueue(
                    { kind: 'DENY', passId: pass.passId, reason, ...(gate ? { gate } : {}) },
                    `${pass.visitorName} refused`,
                  );
                  setResult(null);
                  setDone(`Entry refused for ${pass.visitorName}. Saved on this device.`);
                  return;
                }
                void decide
                  .run(() => api.post(`${base}/gate/deny`, { passId: pass.passId, reason, gate }))
                  .then((ok) => {
                    if (!ok) return;
                    setResult(null);
                    setDone(`Entry refused for ${pass.visitorName}.`);
                  });
              }}
            >
              <TextField label="Reason for refusing" name="reason" required maxLength={500} />
              <Button type="submit" variant="danger" busy={decide.busy}>
                Record refusal
              </Button>
            </form>
          ) : (
            <div className="form__actions">
              <Button
                busy={decide.busy}
                onClick={() => {
                  if (result?.offline) {
                    enqueue(
                      { kind: 'ADMIT', passId: pass.passId, ...(gate ? { gate } : {}) },
                      `${pass.visitorName} admitted to unit ${pass.unitNumber}`,
                    );
                    setResult(null);
                    setDone(
                      `${pass.visitorName} admitted to unit ${pass.unitNumber}. Saved on this device: it will be sent when the connection returns.`,
                    );
                    return;
                  }
                  void decide
                    .run(() => api.post(`${base}/gate/admit`, { passId: pass.passId, gate }))
                    .then((ok) => {
                      if (!ok) return;
                      setResult(null);
                      setDone(`${pass.visitorName} admitted to unit ${pass.unitNumber}.`);
                      onAdmitted();
                    });
                }}
              >
                Admit
              </Button>
              <Button variant="danger" onClick={() => setRefusing(true)}>
                Refuse
              </Button>
            </div>
          )}
        </Alert>
      ) : null}
      {done ? <Alert tone="success">{done}</Alert> : null}
    </Card>
  );
}

/** Walk-in requests change within minutes: check often while the screen is open. */
const POLL_MS = 5_000;

function WalkIns({ base, gate, timeZone, onAdmitted, online, offline }: GateProps) {
  const units = useApiQuery<Paginated<UnitDto>>(`${base}/units?limit=200`);
  const requests = useApiQuery<{ data: WalkInRequestDto[] }>(`${base}/gate/walk-in-requests`);
  usePolling(requests.reload, online ? POLL_MS : null);
  const [offlineProblem, setOfflineProblem] = useState<string | null>(null);
  const send = useAction();
  const act = useAction();
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const unitId = String(form.get('unitId') ?? '');
    const optional = (key: string) => {
      const value = String(form.get(key) ?? '').trim();
      return value ? { [key]: value } : {};
    };
    const body = {
      category: String(form.get('category') ?? 'GUEST'),
      visitorName: String(form.get('visitorName') ?? ''),
      ...optional('visitorPhone'),
      ...optional('vehiclePlate'),
      ...(gate ? { gate } : {}),
    };
    setNotice(null);
    setOfflineProblem(null);
    if (!online) {
      // A resident cannot be asked without a connection: no walk-ins to a unit offline.
      if (unitId) {
        setOfflineProblem(
          'Without a connection the residents cannot approve a visitor. Follow the paper procedure.',
        );
        return;
      }
      offline.enqueue(
        {
          kind: 'WALK_IN',
          category: body.category as WalkInRequestDto['category'],
          visitorName: body.visitorName,
          ...('vehiclePlate' in body ? { vehiclePlate: String(body.vehiclePlate) } : {}),
          ...(gate ? { gate } : {}),
        },
        `${body.visitorName} admitted to the property`,
      );
      setNotice(`${body.visitorName} admitted to the property. Saved on this device.`);
      formElement.reset();
      return;
    }
    // To a unit: the residents must approve. To the property itself: recorded and admitted.
    const ok = await send.run(() =>
      unitId
        ? api.post(`${base}/gate/walk-in-requests`, { ...body, unitId })
        : api.post(`${base}/gate/walk-in`, body),
    );
    if (ok) {
      if (!unitId) onAdmitted();
      setNotice(
        unitId
          ? `Request sent. The residents have 10 minutes to answer.`
          : `${body.visitorName} admitted to the property.`,
      );
      formElement.reset();
      requests.reload();
    }
  }

  const fields = fieldErrors(send.error);
  const rows = requests.status === 'success' ? requests.data.data : [];
  const open = rows.filter(
    (r) =>
      r.status === 'PENDING' ||
      (r.status === 'APPROVED' &&
        !r.used &&
        r.approvalValidUntil &&
        secondsUntil(r.approvalValidUntil) > 0),
  );
  return (
    <Card title="Visitor without a pass">
      <form
        className="form form--inline"
        onSubmit={onSubmit}
        noValidate
        aria-label="Visitor without a pass"
      >
        {send.error ? <Alert>{errorMessage(send.error)}</Alert> : null}
        {offlineProblem ? <Alert>{offlineProblem}</Alert> : null}
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        <SelectField
          label="Going to"
          name="unitId"
          defaultValue=""
          hint="A unit's residents must approve"
        >
          <option value="">The property itself (e.g. the office)</option>
          {units.status === 'success'
            ? units.data.data.map((u) => (
                <option key={u.id} value={u.id}>
                  Unit {u.number}
                </option>
              ))
            : null}
        </SelectField>
        <TextField
          label="Visitor's name"
          name="visitorName"
          required
          maxLength={200}
          autoComplete="off"
          error={fields.visitorName}
        />
        <SelectField label="Visitor type" name="category" defaultValue="GUEST">
          {VISITOR_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {enumLabel(c)}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Phone (optional)"
          name="visitorPhone"
          type="tel"
          maxLength={20}
          autoComplete="off"
          error={fields.visitorPhone}
        />
        <TextField
          label="Vehicle plate (optional)"
          name="vehiclePlate"
          maxLength={20}
          autoComplete="off"
          error={fields.vehiclePlate}
        />
        <Button type="submit" busy={send.busy}>
          Continue
        </Button>
      </form>

      {act.error ? <Alert>{errorMessage(act.error)}</Alert> : null}
      {online && requests.status === 'error' ? (
        <ErrorState error={requests.error} onRetry={requests.reload} />
      ) : null}
      {open.length > 0 ? (
        <ul className="list" aria-label="Waiting for residents" aria-live="polite">
          {open.map((r) => (
            <li key={r.id} className="list__item">
              <div>
                <p className="list__primary">
                  {r.visitorName} <span className="muted">to unit {r.unitNumber}</span>
                </p>
                <p className="list__meta">
                  {r.status === 'PENDING'
                    ? `${WALK_IN_STATUS_LABELS.PENDING} · ${Math.ceil(secondsUntil(r.expiresAt) / 60)} min left`
                    : `Approved · admit by ${formatTime(r.approvalValidUntil as string, timeZone)}`}
                </p>
              </div>
              <div className="form__actions">
                {r.status === 'APPROVED' ? (
                  <Button
                    busy={act.busy}
                    aria-label={`Admit ${r.visitorName}`}
                    onClick={() =>
                      void act
                        .run(() =>
                          api.post(`${base}/gate/walk-in-requests/${r.id}/admit`, { gate }),
                        )
                        .then((ok) => {
                          requests.reload();
                          if (ok) onAdmitted();
                        })
                    }
                  >
                    Admit
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    busy={act.busy}
                    aria-label={`Cancel request for ${r.visitorName}`}
                    onClick={() =>
                      void act
                        .run(() => api.post(`${base}/gate/walk-in-requests/${r.id}/cancel`))
                        .then(() => requests.reload())
                    }
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <RecentAnswers rows={rows.filter((r) => !open.includes(r)).slice(0, 5)} timeZone={timeZone} />
    </Card>
  );
}

function RecentAnswers({ rows, timeZone }: { rows: WalkInRequestDto[]; timeZone: string }) {
  if (rows.length === 0) return null;
  return (
    <>
      <h3 className="section-title">Recent requests</h3>
      <ul className="list" aria-label="Recent walk-in requests">
        {rows.map((r) => (
          <li key={r.id} className="list__item">
            <div>
              <p className="list__primary">{r.visitorName}</p>
              <p className="list__meta">
                Unit {r.unitNumber} · {formatTime(r.createdAt, timeZone)}
              </p>
            </div>
            <span className="badge badge--muted">
              {r.used ? 'Admitted' : WALK_IN_STATUS_LABELS[r.status]}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Inside({
  base,
  gate,
  timeZone,
  admissions,
  online,
  offline,
}: GateProps & { admissions: number }) {
  const inside = useApiQuery<{ data: VisitDto[] }>(`${base}/visits/inside`);
  usePolling(inside.reload, online ? 30_000 : null);
  // Keep the last list while offline, so departures can still be recorded.
  const [lastRows, setLastRows] = useState<VisitDto[]>([]);
  useEffect(() => {
    if (inside.status === 'success') setLastRows(inside.data.data);
  }, [inside]);
  const reloadInside = inside.reload;
  useEffect(() => {
    if (admissions > 0) reloadInside();
  }, [admissions, reloadInside]);
  const depart = useAction();
  const departedOffline = new Set(
    offline.queue.flatMap((q) =>
      q.entry.kind === 'DEPART' ? [q.entry.visitId, q.entry.departRef] : [],
    ),
  );
  const rows = (inside.status === 'success' ? inside.data.data : lastRows).filter(
    (v) => !departedOffline.has(v.id),
  );
  const admittedOffline = offline.queue.filter(
    (q) =>
      (q.entry.kind === 'ADMIT' || q.entry.kind === 'WALK_IN') &&
      !departedOffline.has(q.entry.clientRef),
  );
  return (
    <Card title="Inside now">
      {depart.error ? <Alert>{errorMessage(depart.error)}</Alert> : null}
      {inside.status === 'loading' ? <LoadingState label="Loading visitors inside" /> : null}
      {online && inside.status === 'error' ? (
        <ErrorState error={inside.error} onRetry={inside.reload} />
      ) : null}
      {inside.status === 'success' && rows.length === 0 && admittedOffline.length === 0 ? (
        <p className="muted">No visitors are inside.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Visitors inside">
          {rows.map((v) => (
            <li key={v.id} className="list__item">
              <div>
                <p className="list__primary">{v.visitorName}</p>
                <p className="list__meta">
                  {v.unitNumber ? `Unit ${v.unitNumber}` : 'Property'} · since{' '}
                  {formatTime(v.arrivedAt, timeZone)}
                  {v.vehiclePlate ? ` · ${v.vehiclePlate}` : ''}
                </p>
              </div>
              <Button
                variant="secondary"
                busy={depart.busy}
                aria-label={`Record that ${v.visitorName} left`}
                onClick={() => {
                  if (!online) {
                    offline.enqueue(
                      { kind: 'DEPART', visitId: v.id, ...(gate ? { gate } : {}) },
                      `${v.visitorName} left`,
                    );
                    return;
                  }
                  void depart
                    .run(() => api.post(`${base}/visits/${v.id}/depart`, { gate }))
                    .then(() => inside.reload());
                }}
              >
                Left
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {admittedOffline.length > 0 ? (
        <ul className="list" aria-label="Admitted while offline">
          {admittedOffline.map((q) => (
            <li key={q.entry.clientRef} className="list__item">
              <div>
                <p className="list__primary">{q.label}</p>
                <p className="list__meta">
                  Saved on this device · {formatTime(q.entry.occurredAt, timeZone)}
                </p>
              </div>
              <Button
                variant="secondary"
                aria-label={`Record that ${q.label} left`}
                onClick={() =>
                  offline.enqueue(
                    { kind: 'DEPART', departRef: q.entry.clientRef, ...(gate ? { gate } : {}) },
                    `${q.label}: left`,
                  )
                }
              >
                Left
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
