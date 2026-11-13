import type { MyInvoiceDetailDto } from '@veyra/api-contracts';
import { formatMoney, INVOICE_STATE_TONES, invoiceState, isPositive } from '@veyra/client/finance';
import { formatDate } from '@veyra/client/residents';
import { useLocalSearchParams } from 'expo-router';
import { Badge, Body, Card, Heading, Loaded, Muted, Row, Screen, Title } from '@/components/ui';
import { useHome } from '@/lib/home';
import { useApiQuery } from '@/lib/use-api';

export default function InvoiceScreen() {
  const home = useHome();
  const { invoiceId } = useLocalSearchParams<{ invoiceId: string }>();
  const invoice = useApiQuery<MyInvoiceDetailDto>(
    `${home.unitPath}/my-finance/invoices/${invoiceId}`,
  );
  return (
    <Screen onRefresh={invoice.reload} refreshing={invoice.refreshing}>
      <Loaded query={invoice}>
        {(i) => {
          const state = invoiceState(i);
          return (
            <>
              <Card>
                <Row>
                  <Title>{i.number}</Title>
                  <Badge tone={INVOICE_STATE_TONES[state]}>{state}</Badge>
                </Row>
                <Muted>
                  Issued {i.issueDate ? formatDate(i.issueDate) : '—'} · due {formatDate(i.dueDate)}
                </Muted>
                <Body>Total {formatMoney(i.total)}</Body>
                {isPositive(i.paid) ? <Muted>Paid {formatMoney(i.paid)}</Muted> : null}
                {isPositive(i.credited) ? <Muted>Credited {formatMoney(i.credited)}</Muted> : null}
                <Title>
                  {isPositive(i.outstanding)
                    ? `${formatMoney(i.outstanding)} to pay`
                    : 'Nothing to pay'}
                </Title>
              </Card>
              <Heading>Lines</Heading>
              {i.lines.map((line) => (
                <Card key={line.lineNumber}>
                  <Row>
                    <Body>{line.description}</Body>
                  </Row>
                  <Muted>{formatMoney(line.amount)}</Muted>
                </Card>
              ))}
              {i.credits.length > 0 ? (
                <>
                  <Heading>Credits</Heading>
                  {i.credits.map((c) => (
                    <Card key={c.id}>
                      <Body>{c.reason}</Body>
                      <Muted>
                        {formatMoney(c.amount)} · {formatDate(c.creditedOn)}
                      </Muted>
                    </Card>
                  ))}
                </>
              ) : null}
            </>
          );
        }}
      </Loaded>
    </Screen>
  );
}
