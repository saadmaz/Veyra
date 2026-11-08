import { cssVariables } from '@veyra/design-tokens';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'VEYRA Platform Admin', template: '%s · VEYRA Platform Admin' },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{cssVariables()}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
