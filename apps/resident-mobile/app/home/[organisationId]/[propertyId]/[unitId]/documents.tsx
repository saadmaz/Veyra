import type { AttachmentDownloadDto, DocumentDto } from '@veyra/api-contracts';
import { CATEGORY_LABELS, expiryText } from '@veyra/client/communications';
import { formatBytes } from '@veyra/client/maintenance';
import * as Linking from 'expo-linking';
import { Card, ErrorText, Loaded, Muted, Screen, Title } from '@/components/ui';
import { useHome } from '@/lib/home';
import { useClient } from '@/lib/session';
import { useAction, useApiQuery } from '@/lib/use-api';

export default function DocumentsScreen() {
  const home = useHome();
  const client = useClient();
  const path = `${home.orgPath}/properties/${home.propertyId}/units/${home.unitId}/documents`;
  const documents = useApiQuery<{ data: DocumentDto[] }>(path);
  const action = useAction();

  // Signed links expire within minutes, so each tap asks for a fresh one.
  const open = (d: DocumentDto) =>
    void action.run(async () => {
      const { url } = await client.get<AttachmentDownloadDto>(`${path}/${d.id}/download`);
      await Linking.openURL(url);
    });

  return (
    <Screen onRefresh={documents.reload} refreshing={documents.refreshing}>
      <ErrorText error={action.error} />
      <Loaded
        query={documents}
        empty="No documents for your home yet."
        isEmpty={(d) => d.data.filter((doc) => doc.current).length === 0}
      >
        {(d) =>
          d.data
            .filter((doc) => doc.current)
            .map((doc) => (
              <Card key={doc.id} onPress={() => open(doc)} label={`Open ${doc.title}`}>
                <Title>{doc.title}</Title>
                <Muted>
                  {CATEGORY_LABELS[doc.category]}
                  {doc.current ? ` · ${formatBytes(doc.current.sizeBytes)}` : ''}
                </Muted>
                {expiryText(doc) ? <Muted>{expiryText(doc)}</Muted> : null}
              </Card>
            ))
        }
      </Loaded>
    </Screen>
  );
}
