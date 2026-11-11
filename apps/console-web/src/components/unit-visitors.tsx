'use client';

import type {
  CreateVisitorInvitationResponse,
  VisitorInvitationDto,
  WalkInRequestDto,
} from '@veyra/api-contracts';
import { type FormEvent, useState } from 'react';
import { QrCode } from '@/components/qr-code';
import {
  Alert,
  Button,
  Card,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api-client';
import { enumLabel, errorMessage, fieldErrors } from '@/lib/messages';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';
import { usePolling } from '@/lib/use-polling';
import {
  formatInstant,
  instantToZonedLocal,
  secondsUntil,
  VISITOR_CATEGORIES,
  WALK_IN_STATUS_LABELS,
  zonedLocalToInstant,
} from '@/lib/visitors';

/*
 * A unit's visitors (Phase 5): residents and staff register visitors and share the pass; the
 * unit's residents answer walk-in requests from the gate. The API enforces every rule.
 */

/** Walk-in requests need an answer within minutes: check often while the page is open. */
const WALK_IN_POLL_MS = 5_000;

function invitationState(i: VisitorInvitationDto, now: number) {
  if (i.status === 'REVOKED') return { text: 'cancelled', tone: 'muted' };
  if (Date.parse(i.validUntil) < now) return { text: 'ended', tone: 'muted' };
  if (i.entriesUsed >= i.maxEntries) return { text: 'used', tone: 'muted' };
  if (Date.parse(i.validFrom) > now) return { text: 'upcoming', tone: 'warning' };
  return { text: 'active', tone: 'success' };
}

export function UnitVisitorsCard({
  unitPath,
  timeZone,
  canInvite,
}: {
  /** …/properties/:propertyId/units/:unitId */
  unitPath: string;
  timeZone: string;
  canInvite: boolean;
}) {
  const invitations = useApiQuery<{ data: VisitorInvitationDto[] }>(
    `${unitPath}/visitor-invitations`,
  );
  const create = useAction();
  const revoke = useAction();
  const [problem, setProblem] = useState<string | null>(null);
  const [issued, setIssued] = useState<CreateVisitorInvitationResponse | null>(null);
  // Defaults: from now for four hours, in the property's own time.
  const [defaults] = useState(() => {
    const now = Date.now();
    return {
      from: instantToZonedLocal(new Date(now), timeZone),
      until: instantToZonedLocal(new Date(now + 4 * 3_600_000), timeZone),
    };
  });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const validFrom = zonedLocalToInstant(String(form.get('validFrom') ?? ''), timeZone);
    const validUntil = zonedLocalToInstant(String(form.get('validUntil') ?? ''), timeZone);
    if (!validFrom || !validUntil) return setProblem('Enter when the visit starts and ends.');
    setProblem(null);
    const optional = (key: string) => {
      const value = String(form.get(key) ?? '').trim();
      return value ? { [key]: value } : {};
    };
    let response: CreateVisitorInvitationResponse | undefined;
    const ok = await create.run(async () => {
      response = await api.post<CreateVisitorInvitationResponse>(
        `${unitPath}/visitor-invitations`,
        {
          category: String(form.get('category') ?? 'GUEST'),
          visitorName: String(form.get('visitorName') ?? ''),
          ...optional('visitorPhone'),
          ...optional('vehiclePlate'),
          validFrom,
          validUntil,
          maxEntries: Number(form.get('maxEntries') ?? 1),
        },
      );
    });
    if (ok && response) {
      setIssued(response);
      formElement.reset();
      invitations.reload();
    }
  }

  const fields = fieldErrors(create.error);
  const now = Date.now();
  const rows = invitations.status === 'success' ? invitations.data.data : [];
  return (
    <Card title="Visitors">
      {issued ? (
        <Alert tone="success" title={`Pass for ${issued.invitation.visitorName}`}>
          <p>
            Share the QR code or the reference code with your visitor. It is shown only now; if it
            is lost, cancel this visitor and register them again. The guard will still check who
            they are.
          </p>
          <div className="pass">
            <QrCode
              value={issued.pass.token}
              label={`QR code for ${issued.invitation.visitorName}`}
            />
            <p className="pass__code">
              Reference code <strong>{issued.pass.code}</strong>
            </p>
          </div>
          <Button variant="secondary" onClick={() => setIssued(null)}>
            Done
          </Button>
        </Alert>
      ) : null}
      {revoke.error ? <Alert>{errorMessage(revoke.error)}</Alert> : null}
      {invitations.status === 'loading' ? <LoadingState label="Loading visitors" /> : null}
      {invitations.status === 'error' ? (
        <ErrorState error={invitations.error} onRetry={invitations.reload} />
      ) : null}
      {invitations.status === 'success' && rows.length === 0 ? (
        <p className="muted">No visitors registered.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Registered visitors">
          {rows.map((i) => {
            const state = invitationState(i, now);
            return (
              <li key={i.id} className="list__item">
                <div>
                  <p className="list__primary">
                    {i.visitorName} <span className="muted">({enumLabel(i.category)})</span>
                  </p>
                  <p className="list__meta">
                    {formatInstant(i.validFrom, timeZone)} to{' '}
                    {formatInstant(i.validUntil, timeZone)} · {i.entriesUsed} of {i.maxEntries}{' '}
                    {i.maxEntries === 1 ? 'entry' : 'entries'}
                    {i.vehiclePlate ? ` · ${i.vehiclePlate}` : null}
                  </p>
                </div>
                <div className="form__actions">
                  <span className={`badge badge--${state.tone}`}>{state.text}</span>
                  {canInvite && (state.text === 'active' || state.text === 'upcoming') ? (
                    <Button
                      variant="danger"
                      busy={revoke.busy}
                      aria-label={`Cancel visitor ${i.visitorName}`}
                      onClick={() => {
                        if (!window.confirm(`Cancel the pass of ${i.visitorName}?`)) return;
                        void revoke
                          .run(() => api.post(`${unitPath}/visitor-invitations/${i.id}/revoke`))
                          .then((ok) => ok && invitations.reload());
                      }}
                    >
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {canInvite ? (
        <form
          className="form form--inline"
          onSubmit={onSubmit}
          noValidate
          aria-label="Register a visitor"
        >
          {problem ? <Alert>{problem}</Alert> : null}
          {create.error ? <Alert>{errorMessage(create.error)}</Alert> : null}
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
            label="Visitor's phone (optional)"
            name="visitorPhone"
            type="tel"
            maxLength={20}
            hint="International format, e.g. +923001234567"
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
          <TextField
            label="From"
            name="validFrom"
            type="datetime-local"
            required
            defaultValue={defaults.from}
            hint={`Property time (${timeZone.replaceAll('_', ' ')})`}
            error={fields.validFrom}
          />
          <TextField
            label="Until"
            name="validUntil"
            type="datetime-local"
            required
            defaultValue={defaults.until}
            hint="At most 31 days after the start"
            error={fields.validUntil}
          />
          <TextField
            label="Entries allowed"
            name="maxEntries"
            type="number"
            min={1}
            max={50}
            defaultValue={1}
            error={fields.maxEntries}
          />
          <Button type="submit" busy={create.busy}>
            Register visitor
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

/**
 * Walk-in requests from the gate. Only residents of the unit may answer (the API refuses staff);
 * staff see them read-only. Checks for new requests every few seconds while the page is open.
 */
export function WalkInRequestsCard({
  unitPath,
  timeZone,
  canAnswer,
}: {
  unitPath: string;
  timeZone: string;
  canAnswer: boolean;
}) {
  const requests = useApiQuery<{ data: WalkInRequestDto[] }>(`${unitPath}/walk-in-requests`);
  usePolling(requests.reload, WALK_IN_POLL_MS);
  const answer = useAction();

  const rows = requests.status === 'success' ? requests.data.data : [];
  const waiting = rows.filter((r) => r.status === 'PENDING');
  const recent = rows.filter((r) => r.status !== 'PENDING').slice(0, 10);
  const decide = (r: WalkInRequestDto, approve: boolean) =>
    void answer
      .run(() => api.post(`${unitPath}/walk-in-requests/${r.id}/${approve ? 'approve' : 'deny'}`))
      .then(() => requests.reload());

  return (
    <Card title="Visitors at the gate">
      {answer.error ? <Alert>{errorMessage(answer.error)}</Alert> : null}
      {requests.status === 'loading' ? <LoadingState label="Loading requests" /> : null}
      {requests.status === 'error' ? (
        <ErrorState error={requests.error} onRetry={requests.reload} />
      ) : null}
      {requests.status === 'success' && waiting.length === 0 ? (
        <p className="muted">Nobody is waiting at the gate for this unit.</p>
      ) : null}
      {waiting.length > 0 ? (
        <ul className="list" aria-label="Waiting at the gate" aria-live="polite">
          {waiting.map((r) => (
            <li key={r.id} className="list__item">
              <div>
                <p className="list__primary">
                  {r.visitorName} <span className="muted">({enumLabel(r.category)})</span>
                </p>
                <p className="list__meta">
                  {[r.gate, r.vehiclePlate, r.visitorPhone].filter(Boolean).join(' · ') ||
                    'No details'}{' '}
                  · answer within {Math.ceil(secondsUntil(r.expiresAt) / 60)} min
                </p>
              </div>
              {canAnswer ? (
                <div className="form__actions">
                  <Button
                    busy={answer.busy}
                    onClick={() => decide(r, true)}
                    aria-label={`Let in ${r.visitorName}`}
                  >
                    Let in
                  </Button>
                  <Button
                    variant="danger"
                    busy={answer.busy}
                    onClick={() => decide(r, false)}
                    aria-label={`Refuse ${r.visitorName}`}
                  >
                    Refuse
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!canAnswer && waiting.length > 0 ? (
        <p className="muted">Only the unit's residents can answer these requests.</p>
      ) : null}
      {recent.length > 0 ? (
        <>
          <h3 className="section-title">Recent answers</h3>
          <ul className="list" aria-label="Recent walk-in requests">
            {recent.map((r) => (
              <li key={r.id} className="list__item">
                <div>
                  <p className="list__primary">{r.visitorName}</p>
                  <p className="list__meta">{formatInstant(r.createdAt, timeZone)}</p>
                </div>
                <span className="badge badge--muted">{WALK_IN_STATUS_LABELS[r.status]}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
