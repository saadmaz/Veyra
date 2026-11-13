import type { GatePassView, ValidatePassResponse } from '@veyra/api-contracts';
import { enumLabel } from '@veyra/client/messages';
import {
  checkOffline,
  type OfflineRejection,
  queuedAdmissionsByPass,
} from '@veyra/client/offline-gate';
import { formatInstant } from '@veyra/client/visitors';
import { space } from '@veyra/design-tokens';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { GateStatus } from '@/components/gate-status';
import {
  Body,
  Button,
  Card,
  ErrorText,
  Field,
  Muted,
  Notice,
  Row,
  Screen,
  Title,
} from '@/components/ui';
import { OFFLINE_MESSAGES } from '@/lib/gate';
import { useGate } from '@/lib/gate-context';
import { hashCode, hashToken } from '@/lib/gate-device';
import { useClient } from '@/lib/session';
import { useSite } from '@/lib/site';
import { useAction } from '@/lib/use-api';
import { isNetworkError } from '@/lib/use-gate';

type Checked =
  | { valid: true; pass: GatePassView; offline: boolean }
  | { valid: false; reason: OfflineRejection; offline: boolean };

export default function GateScreen() {
  const site = useSite();
  const client = useClient();
  const gate = useGate();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState('');
  const [checked, setChecked] = useState<Checked | null>(null);
  const [refusing, setRefusing] = useState(false);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const check = useAction();
  const act = useAction();
  const lastScan = useRef<{ token: string; at: number } | null>(null);
  const tz = site.property.timeZone;

  const checkWithoutConnection = useCallback(
    async (body: { token?: string; code?: string }) => {
      if (!gate) return;
      const match = body.token
        ? { tokenHash: await hashToken(body.token) }
        : { codeHash: await hashCode(site.propertyId, body.code ?? '') };
      const result = checkOffline(gate.list, match, queuedAdmissionsByPass(gate.queue));
      setChecked(
        result.valid
          ? {
              valid: true,
              offline: true,
              pass: {
                ...result.entry,
                entriesLeft:
                  result.entry.entriesLeft -
                  (queuedAdmissionsByPass(gate.queue).get(result.entry.passId) ?? 0),
              },
            }
          : { valid: false, reason: result.reason, offline: true },
      );
    },
    [gate, site.propertyId],
  );

  const validate = useCallback(
    async (body: { token?: string; code?: string }) => {
      if (!gate) return;
      setDone(null);
      setChecked(null);
      setRefusing(false);
      if (!gate.online) return checkWithoutConnection(body);
      let unreachable = false;
      await check.run(async () => {
        try {
          const response = await client.post<ValidatePassResponse>(`${site.base}/gate/validate`, {
            ...body,
            ...(gate.gate ? { gate: gate.gate } : {}),
          });
          setChecked({ ...response, offline: false });
        } catch (error) {
          if (!isNetworkError(error)) throw error;
          unreachable = true;
        }
      });
      if (unreachable) {
        gate.markOffline();
        await checkWithoutConnection(body);
      }
    },
    [gate, client, site.base, check.run, checkWithoutConnection],
  );

  const onScanned = ({ data }: { data: string }) => {
    // The camera reports the same code many times a second: act on it once.
    const now = Date.now();
    if (lastScan.current && lastScan.current.token === data && now - lastScan.current.at < 5000)
      return;
    lastScan.current = { token: data, at: now };
    setScanning(false);
    void validate({ token: data });
  };

  if (!gate) return null;
  const pass = checked?.valid ? checked.pass : null;
  const gateName = gate.gate ? { gate: gate.gate } : {};

  const admit = (p: GatePassView) => {
    if (checked?.offline) {
      gate.enqueue(
        { kind: 'ADMIT', passId: p.passId, ...gateName },
        `${p.visitorName} (unit ${p.unitNumber}) admitted`,
      );
      setDone(`${p.visitorName} admitted. Saved on this device.`);
      setChecked(null);
      return;
    }
    void act
      .run(() => client.post(`${site.base}/gate/admit`, { passId: p.passId, ...gateName }))
      .then((ok) => {
        if (!ok) return;
        setDone(`${p.visitorName} admitted to unit ${p.unitNumber}.`);
        setChecked(null);
      });
  };

  const refuse = (p: GatePassView) => {
    const why = reason.trim();
    if (!why) return;
    if (checked?.offline) {
      gate.enqueue(
        { kind: 'DENY', passId: p.passId, reason: why, ...gateName },
        `${p.visitorName} refused`,
      );
      setDone(`${p.visitorName} refused. Saved on this device.`);
    } else {
      void act
        .run(() =>
          client.post(`${site.base}/gate/deny`, { passId: p.passId, reason: why, ...gateName }),
        )
        .then((ok) => {
          if (ok) setDone(`${p.visitorName} refused.`);
        });
    }
    setChecked(null);
    setRefusing(false);
    setReason('');
  };

  return (
    <Screen>
      <GateStatus />
      {done ? <Notice>{done}</Notice> : null}

      {scanning ? (
        permission?.granted ? (
          <View style={{ height: 320, borderRadius: 12, overflow: 'hidden' }}>
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={onScanned}
              accessibilityLabel="Camera. Point it at the visitor's QR code."
            />
          </View>
        ) : (
          <Card>
            <Body>
              The camera is needed to scan QR codes. You can also type the pass code below.
            </Body>
            <Button title="Allow the camera" onPress={() => void requestPermission()} />
          </Card>
        )
      ) : null}
      <Button
        title={scanning ? 'Stop scanning' : 'Scan a QR code'}
        variant={scanning ? 'secondary' : 'primary'}
        onPress={() => {
          setDone(null);
          setScanning(!scanning);
        }}
      />

      <Field
        label="Or type the pass code"
        value={code}
        onChangeText={setCode}
        autoCapitalize="characters"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={() => code.trim() && void validate({ code: code.trim() })}
      />
      <Button
        title="Check code"
        variant="secondary"
        pending={check.pending}
        disabled={!code.trim()}
        onPress={() => void validate({ code: code.trim() })}
      />
      <ErrorText error={check.error} />

      {checked && !checked.valid ? (
        <Notice tone="danger">{OFFLINE_MESSAGES[checked.reason]}</Notice>
      ) : null}

      {pass ? (
        <Card>
          <Title>{pass.visitorName}</Title>
          <Muted>
            {enumLabel(pass.category)} · unit {pass.unitNumber}
            {pass.vehiclePlate ? ` · ${pass.vehiclePlate}` : ''}
          </Muted>
          <Muted>
            Valid until {formatInstant(pass.validUntil, tz)} · {pass.entriesLeft}{' '}
            {pass.entriesLeft === 1 ? 'entry' : 'entries'} left
          </Muted>
          {checked?.offline ? <Muted>Checked against the saved list (no connection).</Muted> : null}
          <ErrorText error={act.error} />
          {refusing ? (
            <View style={{ gap: space[2] }}>
              <Field label="Why are you refusing entry?" value={reason} onChangeText={setReason} />
              <Row>
                <Button
                  title="Refuse entry"
                  variant="danger"
                  disabled={!reason.trim()}
                  pending={act.pending}
                  onPress={() => refuse(pass)}
                />
                <Button title="Back" variant="secondary" onPress={() => setRefusing(false)} />
              </Row>
            </View>
          ) : (
            <Row>
              <Button title="Let in" pending={act.pending} onPress={() => admit(pass)} />
              <Button title="Refuse" variant="secondary" onPress={() => setRefusing(true)} />
            </Row>
          )}
        </Card>
      ) : null}

      <Field
        label="Gate name (optional)"
        value={gate.gate}
        onChangeText={gate.setGate}
        placeholder="Main gate"
        hint="Recorded with each entry from this phone."
      />
    </Screen>
  );
}
