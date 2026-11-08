import type { ReactNode } from 'react';

/** Centred, single-column layout for sign-in and sign-up. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="auth">
      <div className="auth__panel">
        <p className="brand brand--large">VEYRA</p>
        {children}
      </div>
    </main>
  );
}
