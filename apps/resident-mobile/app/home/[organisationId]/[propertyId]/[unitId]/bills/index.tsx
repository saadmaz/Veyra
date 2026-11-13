import type { BankTransferDto, InvoiceDto, MyFinanceDto } from '@veyra/api-contracts';
import {
  balanceText,
  formatMoney,
  INVOICE_STATE_TONES,
  invoiceState,
  isPositive,
  TRANSFER_STATUS_LABELS,
  TRANSFER_STATUS_TONES,
} from '@veyra/client/finance';
import { formatDate } from '@veyra/client/residents';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Badge,
  Body,
  Button,
  Card,
  ErrorText,
  Field,
  fieldError,
  Heading,
  Loaded,
  Muted,
  Notice,
  Row,
  Screen,
  Title,
} from '@/components/ui';
import { todayAt } from '@/lib/dates';
import { useHome } from '@/lib/home';
import { useClient } from '@/lib/session';
import { useAction, useApiQuery } from '@/lib/use-api';

const PARTY = { OWNERS: "Owners' account", TENANTS: "Tenants' account" } as const;

export default function BillsScreen() {
  const home = useHome();
  const client = useClient();
  const router = useRouter();
  const base = `${home.unitPath}/my-finance`;
  const summary = useApiQuery<MyFinanceDto>(base);
  const invoices = useApiQuery<{ data: InvoiceDto[] }>(`${base}/invoices`);
  const transfers = useApiQuery<{ data: BankTransferDto[] }>(`${base}/bank-transfers`);
  const canPay = home.can('unit.finance.pay');
  const [telling, setTelling] = useState<'OWNERS' | 'TENANTS' | null>(null);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [sent, setSent] = useState(false);
  const action = useAction();

  const submitTransfer = () =>
    telling &&
    void action
      .run(() =>
        client.post(`${base}/bank-transfers`, {
          paidBy: telling,
          amount: amount.trim(),
          reference: reference.trim(),
          transferredOn: todayAt(home.unit.propertyTimeZone),
        }),
      )
      .then((ok) => {
        if (!ok) return;
        setTelling(null);
        setAmount('');
        setReference('');
        setSent(true);
        summary.reload();
        transfers.reload();
      });

  return (
    <Screen
      refreshing={summary.refreshing}
      onRefresh={() => {
        summary.reload();
        invoices.reload();
        transfers.reload();
      }}
    >
      {sent ? (
        <Notice>Thanks. The finance team will match your transfer and send a receipt.</Notice>
      ) : null}
      <Loaded
        query={summary}
        empty="You have no account for this home."
        isEmpty={(s) => s.accounts.length === 0}
      >
        {(s) =>
          s.accounts.map((a) => (
            <Card key={a.paidBy}>
              <Muted>{PARTY[a.paidBy]}</Muted>
              <Title>{balanceText(a.balance)}</Title>
              {isPositive(a.overdue) ? (
                <Badge tone="danger">{formatMoney(a.overdue)} overdue</Badge>
              ) : null}
              {isPositive(a.pendingTransfers) ? (
                <Muted>{formatMoney(a.pendingTransfers)} in transfers waiting to be matched</Muted>
              ) : null}
              {canPay && telling !== a.paidBy ? (
                <Button
                  title="I paid by bank transfer"
                  variant="secondary"
                  onPress={() => setTelling(a.paidBy)}
                />
              ) : null}
              {telling === a.paidBy ? (
                <>
                  <Field
                    label={`Amount (${s.currency})`}
                    value={amount}
                    onChangeText={setAmount}
                    keyboardType="decimal-pad"
                    error={fieldError(action.error, 'amount')}
                  />
                  <Field
                    label="Bank reference"
                    value={reference}
                    onChangeText={setReference}
                    error={fieldError(action.error, 'reference')}
                  />
                  <ErrorText error={action.error} />
                  <Row>
                    <Button
                      title="Send"
                      onPress={submitTransfer}
                      pending={action.pending}
                      disabled={!amount.trim() || !reference.trim()}
                    />
                    <Button title="Back" variant="secondary" onPress={() => setTelling(null)} />
                  </Row>
                </>
              ) : null}
            </Card>
          ))
        }
      </Loaded>

      <Heading>Invoices</Heading>
      <Loaded query={invoices} empty="No invoices yet." isEmpty={(d) => d.data.length === 0}>
        {(d) =>
          d.data.map((i) => {
            const state = invoiceState(i);
            return (
              <Card
                key={i.id}
                onPress={() => router.push(`${home.route}/bills/${i.id}`)}
                label={`Invoice ${i.number ?? ''}, ${state}`}
              >
                <Row>
                  <Title>{formatMoney(i.total)}</Title>
                  <Badge tone={INVOICE_STATE_TONES[state]}>{state}</Badge>
                </Row>
                <Muted>
                  {i.number} · due {formatDate(i.dueDate)}
                  {isPositive(i.outstanding) ? ` · ${formatMoney(i.outstanding)} to pay` : ''}
                </Muted>
              </Card>
            );
          })
        }
      </Loaded>

      <Heading>Bank transfers you told us about</Heading>
      <Loaded query={transfers} empty="None." isEmpty={(d) => d.data.length === 0}>
        {(d) =>
          d.data.slice(0, 10).map((t) => (
            <Card key={t.id}>
              <Row>
                <Body>{formatMoney(t.amount)}</Body>
                <Badge tone={TRANSFER_STATUS_TONES[t.status]}>
                  {TRANSFER_STATUS_LABELS[t.status]}
                </Badge>
              </Row>
              <Muted>
                {formatDate(t.transferredOn)} · {t.reference}
                {t.rejectionReason ? ` · ${t.rejectionReason}` : ''}
              </Muted>
            </Card>
          ))
        }
      </Loaded>
    </Screen>
  );
}
