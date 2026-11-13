import { useMemo } from 'react';
import { View } from 'react-native';
import { qrMatrix } from '@/lib/qr';

/** A QR code drawn with plain views: always black on white, in both themes, for scanners. */
export function QrCode({
  value,
  label,
  size = 240,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const matrix = useMemo(() => qrMatrix(value), [value]);
  const margin = 4;
  const cell = Math.floor(size / (matrix.size + margin * 2));
  const extent = cell * (matrix.size + margin * 2);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{
        width: extent,
        height: extent,
        backgroundColor: '#ffffff',
        alignSelf: 'center',
        padding: cell * margin,
      }}
    >
      {matrix.rows.map((runs, y) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder.
        <View key={y} style={{ height: cell, width: cell * matrix.size }}>
          {runs.map(([start, length]) => (
            <View
              key={start}
              style={{
                position: 'absolute',
                left: start * cell,
                width: length * cell,
                height: cell,
                backgroundColor: '#000000',
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
