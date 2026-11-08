'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ErrorState, LoadingState } from '@/components/ui';
import { useSession } from '@/lib/session';

/** Entry point: signed-in users go to their organisations, everyone else to sign-in. */
export default function HomePage() {
  const { session, refresh } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (session.status === 'signed-in') router.replace('/organisations');
    if (session.status === 'signed-out') router.replace('/sign-in');
  }, [session.status, router]);

  return (
    <main className="page page--center">
      {session.status === 'error' ? (
        <ErrorState error={session.error} onRetry={() => void refresh()} />
      ) : (
        <LoadingState />
      )}
    </main>
  );
}
