import { cssVariables } from '@veyra/design-tokens';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { SessionProvider } from '@/lib/session';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'VEYRA Console', template: '%s · VEYRA Console' },
  description: 'Manage your organisation and properties on VEYRA.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Design tokens from @veyra/design-tokens, shared with the mobile app. */}
        <style>{cssVariables()}</style>
      </head>
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
