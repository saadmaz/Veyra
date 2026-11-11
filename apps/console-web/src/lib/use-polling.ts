'use client';

import { useEffect } from 'react';

/**
 * Calls `tick` every `intervalMs` while the page is visible (and once when it becomes visible
 * again). Used for walk-in requests until updates are pushed to the browser. Pass null to stop.
 */
export function usePolling(tick: () => void, intervalMs: number | null): void {
  useEffect(() => {
    if (intervalMs === null) return;
    const run = () => {
      if (document.visibilityState === 'visible') tick();
    };
    const timer = window.setInterval(run, intervalMs);
    document.addEventListener('visibilitychange', run);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  }, [tick, intervalMs]);
}
