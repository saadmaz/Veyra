'use client';

import type { ExportListDto, ExportName, PropertyDashboardDto } from '@veyra/api-contracts';
import { type FormEvent, useState } from 'react';
import { formatMoney } from '@/lib/finance';
import { errorMessage } from '@/lib/messages';
import { EXPORT_LABELS, fetchExport, saveFile } from '@/lib/reporting';
import { useApiQuery } from '@/lib/use-api';
import { Alert, Button, Card, ErrorState, LoadingState, SelectField, TextField } from './ui';

function Figure({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** The property's figures, area by area, as far as the caller may see them. */
export function PropertyFigures({ propertyPath }: { propertyPath: string }) {
  const dashboard = useApiQuery<PropertyDashboardDto>(`${propertyPath}/dashboard`);
  if (dashboard.status === 'loading') return <LoadingState label="Loading figures" />;
  if (dashboard.status === 'error') {
    return <ErrorState error={dashboard.error} onRetry={dashboard.reload} />;
  }
  const d = dashboard.data;
  const areas: { title: string; figures: [string, string | number][] }[] = [];
  if (d.occupancy) {
    areas.push({
      title: 'Occupancy',
      figures: [
        ['Units', d.occupancy.units],
        ['With an owner', d.occupancy.withOwner],
        ['Tenanted', d.occupancy.tenanted],
      ],
    });
  }
  if (d.finance) {
    areas.push({
      title: 'Finance',
      figures: [
        ['Outstanding', formatMoney(d.finance.outstanding)],
        ['Overdue', formatMoney(d.finance.overdue)],
        ['Overdue invoices', d.finance.overdueInvoices],
        ['Collected in 30 days', formatMoney(d.finance.collectedLast30Days)],
      ],
    });
  }
  if (d.maintenance) {
    areas.push({
      title: 'Maintenance',
      figures: [
        ['Open requests', d.maintenance.openRequests],
        ['Past their due time', d.maintenance.overdueRequests],
        ['Open work orders', d.maintenance.openWorkOrders],
      ],
    });
  }
  if (d.visitors) {
    areas.push({
      title: 'Visitors',
      figures: [
        ['Arrived today', d.visitors.arrivedToday],
        ['On site now', d.visitors.onSiteNow],
        ['Last 7 days', d.visitors.last7Days],
      ],
    });
  }
  if (d.facilities) {
    areas.push({
      title: 'Facilities',
      figures: [
        ['Bookings in 7 days', d.facilities.bookingsNext7Days],
        ['Awaiting approval', d.facilities.awaitingApproval],
      ],
    });
  }
  if (d.incidents) {
    areas.push({
      title: 'Incidents',
      figures: [
        ['Open', d.incidents.open],
        ['High or critical', d.incidents.openHighOrCritical],
      ],
    });
  }
  if (d.pendingApprovals !== null) {
    areas.push({ title: 'Approvals', figures: [['Waiting', d.pendingApprovals]] });
  }
  if (areas.length === 0) return null;
  return (
    <section className="kpi-board" aria-label={`Today (${d.asOf})`}>
      <h2 className="kpi-board__title">
        Today <span className="muted">· {d.asOf}</span>
      </h2>
      <div className="kpi-grid">
        {areas.map((a) => (
          <section key={a.title} className="kpi" aria-label={`${a.title} figures`}>
            <h3 className="kpi__title">{a.title}</h3>
            <dl className="kpi__figures">
              {a.figures.map(([label, value]) => (
                <Figure key={label} label={label} value={value} />
              ))}
            </dl>
          </section>
        ))}
      </div>
    </section>
  );
}

/** CSV exports the caller may download; each download is recorded. */
export function Exports({ propertyPath }: { propertyPath: string }) {
  const list = useApiQuery<ExportListDto>(`${propertyPath}/exports`);
  const names = list.status === 'success' ? list.data.data : [];
  const [form, setForm] = useState<{ name: ExportName | ''; from: string; to: string }>({
    name: '',
    from: '',
    to: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const name = form.name || names[0];

  if (list.status !== 'success' || names.length === 0 || !name) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (EXPORT_LABELS[name].ranged) {
        if (form.from) query.set('from', form.from);
        if (form.to) query.set('to', form.to);
      }
      const q = query.toString();
      saveFile(await fetchExport(`${propertyPath}/exports/${name}${q ? `?${q}` : ''}`));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Exports">
      <p className="muted">
        CSV files of the areas you can see. Each download is recorded. They leave out names and
        anything residents wrote.
      </p>
      <form onSubmit={submit} aria-label="Download an export" className="form">
        <div className="form__row">
          <SelectField
            label="Report"
            value={name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value as ExportName }))}
          >
            {names.map((n) => (
              <option key={n} value={n}>
                {EXPORT_LABELS[n].title}
              </option>
            ))}
          </SelectField>
          {EXPORT_LABELS[name].ranged ? (
            <>
              <TextField
                label="From (optional)"
                type="date"
                value={form.from}
                onChange={(e) => setForm((f) => ({ ...f, from: e.target.value }))}
              />
              <TextField
                label="To (optional)"
                type="date"
                value={form.to}
                onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))}
              />
            </>
          ) : null}
        </div>
        {EXPORT_LABELS[name].ranged ? (
          <p className="muted">Without dates: the last 30 days. At most 366 days.</p>
        ) : null}
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        <div className="form__actions">
          <Button type="submit" variant="secondary" busy={busy}>
            Download CSV
          </Button>
        </div>
      </form>
    </Card>
  );
}
