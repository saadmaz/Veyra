import type { ReactNode } from 'react';
import { Icon, type IconName } from './icon';

const points: { icon: IconName; text: string }[] = [
  { icon: 'shield', text: 'Role- and property-scoped permissions' },
  { icon: 'lock', text: 'Two-step sign-in for every privileged role' },
  { icon: 'check', text: 'Immutable, auditable financial ledger' },
];

/** Sign-in, sign-up, recovery and invitations: a brand panel beside a single-column form. */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth__brand">
        <p className="brand brand--inverse">
          <span className="brand__mark" aria-hidden="true">
            V
          </span>
          <span className="brand__word">VEYRA</span>
        </p>
        <div className="auth__pitch">
          <p className="auth__headline">
            Intelligent Living.
            <br />
            Unified Operations.
          </p>
          <p className="auth__lede">
            One secure platform for property managers, residents, security and maintenance teams,
            with strict tenant isolation and audit trails by default.
          </p>
          <ul className="auth__points">
            {points.map((p) => (
              <li key={p.text}>
                <Icon name={p.icon} />
                {p.text}
              </li>
            ))}
          </ul>
        </div>
        <p className="auth__foot">© {new Date().getFullYear()} VEYRA</p>
      </aside>
      <main id="main" className="auth__main">
        <div className="auth__panel">{children}</div>
      </main>
    </div>
  );
}
