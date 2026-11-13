'use client';

import type { MyOrganisationDto } from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { signInPath } from '@/lib/navigation';
import { useSession } from '@/lib/session';
import { activeHref, sidebarGroups } from '@/lib/sidebar';
import { useApiQuery } from '@/lib/use-api';
import { Icon } from './icon';
import { VerifyMfa } from './mfa';
import { Alert, Button, ErrorState, LoadingState } from './ui';

/**
 * Signed-in layout: redirects to sign-in when there is no session, then renders the sidebar
 * (organisation switcher, navigation for the current organisation and property, account) and the
 * page.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { session, refresh } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (session.status === 'signed-out') router.replace(signInPath(pathname));
  }, [session.status, router, pathname]);

  if (session.status === 'loading' || session.status === 'signed-out') {
    return (
      <main className="page page--center">
        <LoadingState label="Checking your session" />
      </main>
    );
  }
  if (session.status === 'error') {
    return (
      <main className="page page--center">
        <ErrorState error={session.error} onRetry={() => void refresh()} />
      </main>
    );
  }

  const groups = sidebarGroups(pathname);
  const current = activeHref(pathname, groups);
  const nav = (
    <nav aria-label="Main" className="sidebar__nav">
      {groups.map((group) => (
        <div key={group.label} className="sidebar__group">
          <p className="sidebar__label">{group.label}</p>
          <ul>
            {group.items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="sidebar__link"
                  aria-current={item.href === current ? 'page' : undefined}
                >
                  <Icon name={item.icon} />
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="shell">
        <aside className="sidebar">
          <div className="sidebar__top">
            <Link href="/organisations" className="brand">
              <span className="brand__mark" aria-hidden="true">
                V
              </span>
              <span className="brand__word">VEYRA</span>
            </Link>
            {/* Small screens: a native disclosure, so the menu works without JavaScript. */}
            <details className="sidebar__menu">
              <summary aria-label="Open navigation">
                <Icon name="menu" size={20} />
              </summary>
              <div className="sidebar__panel">
                {nav}
                <AccountMenu displayName={session.user.displayName} email={session.user.email} />
              </div>
            </details>
          </div>
          <OrganisationSwitcher />
          <div className="sidebar__desktop">{nav}</div>
          <div className="sidebar__desktop sidebar__footer">
            <AccountMenu displayName={session.user.displayName} email={session.user.email} />
          </div>
        </aside>
        <main id="main" className="page" tabIndex={-1}>
          {session.user.emailVerified ? null : <ConfirmEmailBanner />}
          {session.user.mfaEnabled && !session.mfaVerified ? <VerifyMfa /> : null}
          {children}
        </main>
      </div>
    </>
  );
}

/** Reminds people to confirm their address, and sends the link again on request. */
function ConfirmEmailBanner() {
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'failed'>('idle');
  async function resend() {
    setState('busy');
    try {
      await api.post('/auth/verify-email/resend');
      setState('sent');
    } catch {
      setState('failed');
    }
  }
  return (
    <Alert tone="info" title="Confirm your email address">
      {state === 'sent'
        ? 'We have sent the link again. It works for a day.'
        : 'Open the link we emailed you when you signed up.'}{' '}
      {state === 'failed' ? 'Sending failed; try again later. ' : null}
      {state === 'sent' ? null : (
        <button
          type="button"
          className="link-button"
          onClick={() => void resend()}
          disabled={state === 'busy'}
        >
          Send it again
        </button>
      )}
    </Alert>
  );
}

/** Native select: keyboard and screen-reader support without custom widget code. */
function OrganisationSwitcher() {
  const router = useRouter();
  const params = useParams<{ organisationId?: string }>();
  const current = typeof params.organisationId === 'string' ? params.organisationId : '';
  const query = useApiQuery<{ data: MyOrganisationDto[] }>('/organisations');
  const pathname = usePathname();
  const { reload } = query;

  // Refresh on navigation, so organisations created or joined a moment ago appear.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger.
  useEffect(() => {
    reload();
  }, [pathname, reload]);

  if (query.status !== 'success' || query.data.data.length === 0) return <span />;

  return (
    <div className="switcher">
      <label htmlFor="organisation-switcher" className="switcher__label">
        Switch organisation
      </label>
      <select
        id="organisation-switcher"
        className="switcher__select"
        value={current}
        onChange={(event) => {
          const id = event.target.value;
          router.push(id ? `/organisations/${id}` : '/organisations');
        }}
      >
        <option value="">All organisations</option>
        {query.data.data.map(({ organisation }) => (
          <option key={organisation.id} value={organisation.id}>
            {organisation.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function AccountMenu({ displayName, email }: { displayName: string; email: string }) {
  const { signOut } = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <div className="account">
      <span className="avatar" aria-hidden="true">
        {initials}
      </span>
      <span className="account__text">
        <span className="account__name">{displayName}</span>
        <span className="account__email">{email}</span>
      </span>
      <Button
        variant="secondary"
        className="account__signout"
        busy={busy}
        aria-label="Sign out"
        title="Sign out"
        onClick={async () => {
          setBusy(true);
          await signOut().catch(() => undefined);
          router.replace('/sign-in');
        }}
      >
        <Icon name="logOut" size={16} />
      </Button>
    </div>
  );
}
