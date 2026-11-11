'use client';

import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/**
 * A QR code drawn as SVG cells (no HTML injection). The value is a visitor pass token: random,
 * revocable and holding no personal data, so showing or sharing it reveals nothing about anyone.
 */
export function QrCode({
  value,
  label,
  size = 200,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    const dark: { x: number; y: number }[] = [];
    for (let y = 0; y < count; y += 1)
      for (let x = 0; x < count; x += 1) if (qr.isDark(y, x)) dark.push({ x, y });
    return { count, dark };
  }, [value]);
  const margin = 4;
  const extent = cells.count + margin * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${extent} ${extent}`}
      shapeRendering="crispEdges"
      className="qr"
    >
      {/* Always dark on white, in both themes: scanners need the contrast. */}
      <rect width={extent} height={extent} fill="#ffffff" />
      <path
        fill="#000000"
        d={cells.dark.map(({ x, y }) => `M${x + margin} ${y + margin}h1v1h-1z`).join('')}
      />
    </svg>
  );
}
