'use client';

import { useCallback, useState } from 'react';

/**
 * State for one user action (create, archive...): busy flag, last error, and a runner that
 * resets the error, awaits the call and reports success. Keeps pages free of repeated
 * try/catch/busy boilerplate.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (caught) {
      setError(caught);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, run, clearError: () => setError(null) };
}

/** Native confirmation dialog: accessible and keyboard-friendly without custom modal code. */
export function confirmArchive(what: string): boolean {
  return window.confirm(
    `Archive ${what}? Archived items stay in the history but cannot be changed.`,
  );
}
