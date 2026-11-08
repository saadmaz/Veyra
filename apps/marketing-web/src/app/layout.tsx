import { cssVariables } from '@veyra/design-tokens';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'VEYRA: Intelligent Living. Unified Operations.', template: '%s · VEYRA' },
  description:
    'VEYRA is the operating platform for condominiums, residential communities and property management organisations.',
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
