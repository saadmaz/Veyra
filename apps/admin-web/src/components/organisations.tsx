'use client';

import type { PlatformOrganisationDto, SupportAccessDto } from '@veyra/api-contracts';
import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { planSummary, supportLabel, when } from '@/lib/platform';

/** Every organisation with its plan, searchable; and the staff member's support requests. */
export function Organisations() {
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<PlatformOrganisationDto[] | null>(null);
  const [support, setSupport] = useState<SupportAccessDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (term: string) => {
    setError(null);
    try {
      const q = term.trim() ? `?search=${encodeURIComponent(term.trim())}` : '';
      const [list, mine] = await Promise.all([
        api.get<{ data: PlatformOrganisationDto[] }>(`/platform/organisations${q}`),
        api.get<{ data: SupportAccessDto[] }>('/platform/support-access'),
      ]);
      setRows(list.data);
      setSupport(mine.data);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void load(search);
  }

  return (
    <main className="page">
      <h1>Organisations</h1>
      <search>
        <form className="row" aria-label="Search organisations" onSubmit={submit}>
          <label className="field">
            <span>Name or slug</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <button type="submit" className="button button--secondary">
            Search
          </button>
        </form>
      </search>
      {error ? (
        <p role="alert" className="alert">
          {error}
        </p>
      ) : null}
      {rows === null && !error ? (
        <p className="muted" role="status">
          Loading organisations…
        </p>
      ) : null}
      {rows?.length === 0 ? <p className="muted">No organisations match.</p> : null}
      {rows && rows.length > 0 ? (
        <table className="table">
          <caption className="visually-hidden">Organisations</caption>
          <thead>
            <tr>
              <th scope="col">Organisation</th>
              <th scope="col">Status</th>
              <th scope="col">Plan</th>
              <th scope="col">Since</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id}>
                <td>
                  <Link href={`/organisations/${o.id}`}>{o.name}</Link>
                  <div className="muted">{o.slug}</div>
                </td>
                <td>{o.status.toLowerCase()}</td>
                <td>{planSummary(o)}</td>
                <td>{when(o.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <h2>Your support requests</h2>
      {support.length === 0 ? <p className="muted">None.</p> : null}
      {support.length > 0 ? (
        <ul className="list" aria-label="Your support requests">
          {support.map((s) => (
            <li key={s.id}>
              <Link href={`/organisations/${s.organisation.id}`}>{s.organisation.name}</Link> ·{' '}
              {supportLabel(s)} · {s.hours} h · {s.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
