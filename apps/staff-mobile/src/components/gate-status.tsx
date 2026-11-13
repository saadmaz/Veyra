import { listMinutesLeft } from '@/lib/gate';
import { useGate } from '@/lib/gate-context';
import { Button, Muted, Notice } from './ui';

/** Connection, saved-list freshness, queued entries and the last sync, in plain words. */
export function GateStatus() {
  const gate = useGate();
  if (!gate) return null;
  const minutes = listMinutesLeft(gate.list?.trustUntil);
  const { lastSync } = gate;
  return (
    <>
      {gate.online ? null : (
        <Notice tone="warning">
          No connection. Passes are checked against the list saved on this device
          {minutes === null
            ? ' (none is usable: follow the paper procedure)'
            : ` (usable for ${minutes} more min)`}
          . Entries are kept on this phone and sent when the connection returns.
        </Notice>
      )}
      {gate.queue.length > 0 ? (
        <Muted>
          {gate.queue.length} {gate.queue.length === 1 ? 'entry' : 'entries'} waiting to be sent.
        </Muted>
      ) : null}
      {lastSync && (lastSync.flagged.length > 0 || lastSync.failed.length > 0) ? (
        <Notice tone={lastSync.failed.length > 0 ? 'danger' : 'warning'}>
          Sent {lastSync.recorded} saved {lastSync.recorded === 1 ? 'entry' : 'entries'}.
          {lastSync.flagged.length > 0
            ? ` A supervisor will review: ${lastSync.flagged.join(', ')}.`
            : ''}
          {lastSync.failed.length > 0
            ? ` Not recorded, write these in the paper log: ${lastSync.failed.map((f) => f.label).join(', ')}.`
            : ''}
        </Notice>
      ) : null}
      {!gate.online ? (
        <Button
          title="Check the connection"
          variant="secondary"
          onPress={() => void gate.checkConnection()}
        />
      ) : null}
    </>
  );
}
