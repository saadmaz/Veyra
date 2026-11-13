import { cssVariables } from '@veyra/design-tokens';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });

export const metadata: Metadata = {
  title: { default: 'VEYRA: Intelligent Living. Unified Operations.', template: '%s · VEYRA' },
  description:
    'VEYRA is the operating platform for condominiums, residential communities and property management organisations.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <head>
        <style>{cssVariables()}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
