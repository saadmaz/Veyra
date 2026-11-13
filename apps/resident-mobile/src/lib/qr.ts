import qrcode from 'qrcode-generator';

/**
 * A QR code as rows of dark runs, so a screen can draw it with plain views (no SVG library).
 * The value is a visitor pass token: random, revocable and free of personal data.
 */
export interface QrMatrix {
  size: number;
  /** Per row, the dark runs as [startColumn, length]. */
  rows: [number, number][][];
}

export function qrMatrix(value: string): QrMatrix {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const size = qr.getModuleCount();
  const rows: [number, number][][] = [];
  for (let y = 0; y < size; y += 1) {
    const runs: [number, number][] = [];
    let start = -1;
    for (let x = 0; x <= size; x += 1) {
      const dark = x < size && qr.isDark(y, x);
      if (dark && start < 0) start = x;
      if (!dark && start >= 0) {
        runs.push([start, x - start]);
        start = -1;
      }
    }
    rows.push(runs);
  }
  return { size, rows };
}
