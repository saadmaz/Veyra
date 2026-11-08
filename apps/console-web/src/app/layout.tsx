import { cssVariables } from '@veyra/design-tokens';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'VEYRA Console', template: '%s · VEYRA Console' },
  description: 'Manage your organisation and properties on VEYRA.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Design tokens from @veyra/design-tokens, shared with the mobile app. */}
        <style>{cssVariables()}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
