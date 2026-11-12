'use client';

import type {
  AttachmentDownloadDto,
  MaintenanceAttachmentDto,
  MaintenanceEventDto,
  MaintenancePriority,
  MaintenanceRequestStatus,
  WorkOrderStatus,
} from '@veyra/api-contracts';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { api } from '@/lib/api-client';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  eventText,
  fileProblem,
  formatBytes,
  PRIORITIES,
  PRIORITY_LABELS,
  REQUEST_STATUS_LABELS,
  REQUEST_STATUS_TONES,
  uploadFile,
  WORK_STATUS_LABELS,
  WORK_STATUS_TONES,
} from '@/lib/maintenance';
import { errorMessage, fieldErrors } from '@/lib/messages';
import { useAction } from '@/lib/use-action';
import { formatInstant } from '@/lib/visitors';
import { Alert, Badge, Button, Card, SelectField, TextField } from './ui';

/*
 * Pieces shared by residents', staff and technicians' maintenance pages (Phase 7 Part 5).
 * The API checks every action; these only decide what to offer.
 */

export function RequestBadge({ status }: { status: MaintenanceRequestStatus }) {
  return <Badge tone={REQUEST_STATUS_TONES[status]}>{REQUEST_STATUS_LABELS[status]}</Badge>;
}

export function WorkBadge({ status }: { status: WorkOrderStatus }) {
  return <Badge tone={WORK_STATUS_TONES[status]}>{WORK_STATUS_LABELS[status]}</Badge>;
}

/** A labelled multi-line text input (the design system has single-line fields only). */
export function TextArea({
  label,
  name,
  maxLength,
  required,
  error,
  hint,
}: {
  label: string;
  name: string;
  maxLength: number;
  required?: boolean;
  error?: string | undefined;
  hint?: string;
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="field">
      <label htmlFor={id} className="field__label">
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        className="field__input"
        rows={4}
        maxLength={maxLength}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />
      {hint ? (
        <p id={`${id}-hint`} className="field__hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="field__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The history, oldest first. Internal entries are marked for staff. */
export function Timeline({
  events,
  timeZone,
  names = (id) => id,
  showVisibility = false,
}: {
  events: MaintenanceEventDto[];
  timeZone: string;
  names?: (userId: string) => string;
  showVisibility?: boolean;
}) {
  return (
    <Card title="History">
      <ol className="list" aria-label="History">
        {events.map((e) => (
          <li key={e.id} className="list__item">
            <div>
              <p className="list__primary">
                {e.type === 'NOTE' ? (
                  <>
                    {e.actor?.name ?? 'Someone'}
                    {e.workOrderNumber ? ` (work ${e.workOrderNumber})` : ''}:{' '}
                    <span className="note">{e.body}</span>
                  </>
                ) : (
                  eventText(e, names)
                )}
                {showVisibility && e.visibility === 'INTERNAL' ? (
                  <>
                    {' '}
                    <Badge>internal</Badge>
                  </>
                ) : null}
              </p>
              <p className="list__meta">
                {formatInstant(e.createdAt, timeZone)}
                {e.type !== 'NOTE' && e.body ? ` · ${e.body}` : ''}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** Photos and PDFs: open through a short-lived link, add, and remove (when allowed). */
export function Attachments({
  items,
  pathOf,
  canRemove,
  upload,
  timeZone,
  onChanged,
}: {
  items: MaintenanceAttachmentDto[];
  /** API path of one attachment, e.g. `${base}/attachments/${id}`. */
  pathOf: (a: MaintenanceAttachmentDto) => string;
  canRemove: (a: MaintenanceAttachmentDto) => boolean;
  /** Where new files go, and with what; omitted when nothing can be added. */
  upload?: {
    base: string;
    choose?: { kind: boolean; visibility: boolean };
  };
  timeZone: string;
  onChanged(): void;
}) {
  const action = useAction();
  const open = (a: MaintenanceAttachmentDto) =>
    void action.run(async () => {
      const link = await api.get<AttachmentDownloadDto>(`${pathOf(a)}/download`);
      window.open(link.url, '_blank', 'noopener');
    });
  const remove = (a: MaintenanceAttachmentDto) => {
    if (!window.confirm(`Remove ${a.fileName}? It is deleted for everyone.`)) return;
    void action.run(() => api.post(`${pathOf(a)}/remove`)).then((ok) => ok && onChanged());
  };
  return (
    <Card title="Photos and files">
      {action.error ? <Alert>{errorMessage(action.error)}</Alert> : null}
      {items.length === 0 ? <p className="muted">No files yet.</p> : null}
      {items.length > 0 ? (
        <ul className="list" aria-label="Photos and files">
          {items.map((a) => (
            <li key={a.id} className="list__item">
              <div>
                <p className="list__primary">
                  {a.fileName} {a.kind !== 'OTHER' ? <Badge>{a.kind.toLowerCase()}</Badge> : null}{' '}
                  {a.visibility === 'INTERNAL' ? <Badge>internal</Badge> : null}
                </p>
                <p className="list__meta">
                  {formatBytes(a.sizeBytes)} · {a.uploadedBy.name} ·{' '}
                  {formatInstant(a.createdAt, timeZone)}
                </p>
              </div>
              <div className="form__actions">
                <Button
                  variant="secondary"
                  aria-label={`Open ${a.fileName}`}
                  busy={action.busy}
                  onClick={() => open(a)}
                >
                  Open
                </Button>
                {canRemove(a) ? (
                  <Button
                    variant="secondary"
                    aria-label={`Remove ${a.fileName}`}
                    busy={action.busy}
                    onClick={() => remove(a)}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {upload ? <UploadForm {...upload} onUploaded={onChanged} /> : null}
    </Card>
  );
}

function UploadForm({
  base,
  choose,
  onUploaded,
}: {
  base: string;
  choose?: { kind: boolean; visibility: boolean };
  onUploaded(): void;
}) {
  const action = useAction();
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const inputId = useId();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get('file');
    if (!(file instanceof File) || file.size === 0) {
      setProblem('Choose a file.');
      return;
    }
    const found = fileProblem(file);
    setProblem(found);
    setDone(null);
    if (found) return;
    const extra = {
      ...(choose?.kind ? { kind: String(data.get('kind')) as 'BEFORE' | 'AFTER' | 'OTHER' } : {}),
      ...(choose?.visibility
        ? { visibility: String(data.get('visibility')) as 'RESIDENT' | 'INTERNAL' }
        : {}),
    };
    const ok = await action.run(() => uploadFile(base, file, extra));
    if (!ok) return;
    form.reset();
    setDone(`${file.name} was added.`);
    onUploaded();
  }

  return (
    <form className="form" noValidate onSubmit={onSubmit} aria-label="Add a file">
      {done ? <Alert tone="success">{done}</Alert> : null}
      {action.error ? <Alert>{errorMessage(action.error)}</Alert> : null}
      <div className="field">
        <label htmlFor={inputId} className="field__label">
          Photo or PDF
        </label>
        <input
          id={inputId}
          name="file"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
          aria-describedby={`${inputId}-hint${problem ? ` ${inputId}-error` : ''}`}
          aria-invalid={problem ? true : undefined}
        />
        <p id={`${inputId}-hint`} className="field__hint">
          Up to 10 MB.
        </p>
        {problem ? (
          <p id={`${inputId}-error`} className="field__error">
            {problem}
          </p>
        ) : null}
      </div>
      {choose?.kind ? (
        <SelectField label="This is" name="kind" defaultValue="OTHER">
          <option value="BEFORE">Before the work</option>
          <option value="AFTER">After the work</option>
          <option value="OTHER">Other</option>
        </SelectField>
      ) : null}
      {choose?.visibility ? <VisibilityField /> : null}
      <Button type="submit" variant="secondary" busy={action.busy}>
        Upload
      </Button>
    </form>
  );
}

function VisibilityField() {
  return (
    <SelectField label="Who sees it" name="visibility" defaultValue="INTERNAL">
      <option value="INTERNAL">Staff only</option>
      <option value="RESIDENT">Staff and the residents</option>
    </SelectField>
  );
}

/** Report a problem; staff also choose the place (a unit or a common area). */
export function ReportForm({
  path,
  places,
  onCreated,
}: {
  path: string;
  places?: { units: { id: string; number: string }[]; commonAreas: { id: string; name: string }[] };
  onCreated(id: string): void;
}) {
  const action = useAction();
  const [problems, setProblems] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (k: string) => String(data.get(k) ?? '').trim();
    const found: Record<string, string> = {};
    if (!text('title')) found.title = 'Say in a few words what is wrong.';
    if (!text('description')) found.description = 'Describe the problem.';
    if (places && !text('place')) found.place = 'Choose where.';
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    const [kind, id] = text('place').split(':');
    let created: { id: string } | undefined;
    const ok = await action.run(async () => {
      const result = await api.post<{ id?: string; request?: { id: string } }>(path, {
        category: text('category'),
        priority: text('priority'),
        title: text('title'),
        description: text('description'),
        ...(text('locationDetail') ? { locationDetail: text('locationDetail') } : {}),
        ...(places ? (kind === 'unit' ? { unitId: id } : { commonAreaId: id }) : {}),
      });
      created = { id: result.request?.id ?? result.id ?? '' };
    });
    if (!ok || !created) return;
    form.reset();
    onCreated(created.id);
  }

  const errors = { ...fieldErrors(action.error), ...problems };
  return (
    <form className="form" noValidate onSubmit={onSubmit} aria-label="Report a problem">
      {action.error && Object.keys(fieldErrors(action.error)).length === 0 ? (
        <Alert>{errorMessage(action.error)}</Alert>
      ) : null}
      {places ? (
        <SelectField label="Where" name="place" defaultValue="" error={errors.place}>
          <option value="">Choose…</option>
          <optgroup label="Units">
            {places.units.map((u) => (
              <option key={u.id} value={`unit:${u.id}`}>
                Unit {u.number}
              </option>
            ))}
          </optgroup>
          <optgroup label="Common areas">
            {places.commonAreas.map((a) => (
              <option key={a.id} value={`area:${a.id}`}>
                {a.name}
              </option>
            ))}
          </optgroup>
        </SelectField>
      ) : null}
      <SelectField label="What kind of problem" name="category" defaultValue="PLUMBING">
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABELS[c]}
          </option>
        ))}
      </SelectField>
      <PriorityField />
      <TextField
        label="In a few words"
        name="title"
        maxLength={120}
        required
        error={errors.title}
      />
      <TextArea
        label="What is wrong"
        name="description"
        maxLength={4000}
        required
        error={errors.description}
      />
      <TextField
        label="Where exactly (optional)"
        name="locationDetail"
        maxLength={200}
        hint="For example: kitchen sink, main bedroom window."
        error={errors.locationDetail}
      />
      <Button type="submit" busy={action.busy}>
        Send report
      </Button>
    </form>
  );
}

export function PriorityField({
  defaultValue = 'MEDIUM',
  label = 'How urgent',
}: {
  defaultValue?: MaintenancePriority;
  label?: string;
}) {
  return (
    <SelectField label={label} name="priority" defaultValue={defaultValue}>
      {PRIORITIES.map((p) => (
        <option key={p} value={p}>
          {PRIORITY_LABELS[p]}
        </option>
      ))}
    </SelectField>
  );
}

/** A message on a request or work order; staff choose who sees it. */
export function NoteForm({
  path,
  chooseVisibility,
  onAdded,
}: {
  path: string;
  chooseVisibility: boolean;
  onAdded(): void;
}) {
  const action = useAction();
  const [problem, setProblem] = useState<string | null>(null);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = String(data.get('body') ?? '').trim();
    if (!body) {
      setProblem('Write a message.');
      return;
    }
    setProblem(null);
    const ok = await action.run(() =>
      api.post(path, {
        body,
        ...(chooseVisibility ? { visibility: String(data.get('visibility')) } : {}),
      }),
    );
    if (!ok) return;
    form.reset();
    onAdded();
  }
  return (
    <form className="form" noValidate onSubmit={onSubmit} aria-label="Add a message">
      {action.error ? <Alert>{errorMessage(action.error)}</Alert> : null}
      <TextArea label="Message" name="body" maxLength={2000} error={problem ?? undefined} />
      {chooseVisibility ? <VisibilityField /> : null}
      <Button type="submit" variant="secondary" busy={action.busy}>
        Add message
      </Button>
    </form>
  );
}

/**
 * A button that asks for a reason (or a note) before doing something, e.g. reject or reopen.
 * `optional` lets the text be left empty.
 */
export function ReasonButton({
  label,
  field,
  submit,
  variant = 'secondary',
  optional = false,
  onDone,
  children,
}: {
  label: string;
  field: string;
  submit(text: string): Promise<unknown>;
  variant?: 'primary' | 'secondary' | 'danger';
  optional?: boolean;
  onDone(): void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const action = useAction();
  if (!open) {
    return (
      <Button variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get('text') ?? '').trim();
    if (!text && !optional) {
      setProblem('This is needed.');
      return;
    }
    setProblem(null);
    const ok = await action.run(() => submit(text));
    if (ok) {
      setOpen(false);
      onDone();
    }
  }
  return (
    <form className="form" noValidate onSubmit={onSubmit} aria-label={label}>
      {action.error ? <Alert>{errorMessage(action.error)}</Alert> : null}
      {children}
      <TextArea label={field} name="text" maxLength={1000} error={problem ?? undefined} />
      <div className="form__actions">
        <Button type="submit" variant={variant} busy={action.busy}>
          {label}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Back
        </Button>
      </div>
    </form>
  );
}

/** Due time and overdue state for staff. */
export function DueText({
  iso,
  overdue,
  timeZone,
}: {
  iso: string | null;
  overdue: boolean;
  timeZone: string;
}) {
  if (!iso) return <>No target</>;
  return (
    <>
      {formatInstant(iso, timeZone)} {overdue ? <Badge tone="danger">overdue</Badge> : null}
    </>
  );
}
