'use client';

import type { MyOrganisationDto } from '@veyra/api-contracts';
import Link from 'next/link';
import { useEffect } from 'react';
import { ButtonLink, EmptyState, ErrorState, LoadingState, StatusBadge } from '@/components/ui';
import { roleLabel } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';

export default function OrganisationsPage() {
  const query = useApiQuery<{ data: MyOrganisationDto[] }>('/organisations');

  useEffect(() => {
    document.title = 'Your organisations · VEYRA Console';
  }, []);

  return (
    <>
      <div className="page__header">
        <h1>Your organisations</h1>
        {query.status === 'success' && query.data.data.length > 0 ? (
          <ButtonLink href="/organisations/new">Create organisation</ButtonLink>
        ) : null}
      </div>

      {query.status === 'loading' ? <LoadingState label="Loading your organisations" /> : null}
      {query.status === 'error' ? <ErrorState error={query.error} onRetry={query.reload} /> : null}
      {query.status === 'success' && query.data.data.length === 0 ? (
        <EmptyState
          title="You are not part of any organisation yet"
          action={<ButtonLink href="/organisations/new">Create an organisation</ButtonLink>}
        >
          Create one for your property management company or residential community, or ask an
          administrator to invite you.
        </EmptyState>
      ) : null}
      {query.status === 'success' && query.data.data.length > 0 ? (
        <ul className="list" aria-label="Organisations">
          {query.data.data.map(({ organisation, roles }) => (
            <li key={organisation.id} className="list__item">
              <div>
                <Link href={`/organisations/${organisation.id}`} className="list__link">
                  {organisation.name}
                </Link>
                <p className="list__meta">{roles.map(roleLabel).join(', ')}</p>
              </div>
              {organisation.status !== 'ACTIVE' ? (
                <StatusBadge status={organisation.status} />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
