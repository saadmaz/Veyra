import Link from 'next/link';
import { contactAction, links } from '../lib/links';
import { Icon } from './icon';

const nav = [
  { label: 'Product', href: '/#product' },
  { label: 'Solutions', href: '/#modules' },
  { label: 'Security', href: '/#trust' },
  { label: 'Pricing', href: '/pricing' },
];

export function Logo() {
  return (
    <Link href="/" className="logo" aria-label="VEYRA home">
      <span className="logo-mark" aria-hidden="true">
        V
      </span>
      <span className="logo-word">VEYRA</span>
    </Link>
  );
}

export function SiteHeader() {
  const cta = contactAction();
  return (
    <header className="site-header">
      <div className="container site-header-inner">
        <Logo />
        <nav aria-label="Main" className="site-nav">
          {nav.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="site-actions">
          <a href={links.signIn} className="sign-in">
            Sign in
          </a>
          <a href={cta.href} className="button button-primary button-sm">
            {cta.label}
          </a>
        </div>
        {/* Small screens: a native disclosure, so the menu works without JavaScript. */}
        <details className="mobile-menu">
          <summary aria-label="Open menu">
            <Icon name="menu" />
          </summary>
          <div className="mobile-menu-panel">
            {nav.map((item) => (
              <Link key={item.href} href={item.href}>
                {item.label}
              </Link>
            ))}
            <a href={links.signIn}>Sign in</a>
            <a href={cta.href} className="button button-primary">
              {cta.label}
            </a>
          </div>
        </details>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const cta = contactAction();
  const columns = [
    {
      heading: 'Product',
      items: [
        { label: 'Console', href: '/#product' },
        { label: 'Resident app', href: '/#product' },
        { label: 'Operations app', href: '/#product' },
        { label: 'Pricing', href: '/pricing' },
      ],
    },
    {
      heading: 'Company',
      items: [
        { label: cta.label === 'Talk to us' ? 'Contact' : 'Start free trial', href: cta.href },
      ],
    },
    {
      heading: 'Trust',
      items: [
        { label: 'Security', href: '/#trust' },
        { label: 'Sign in', href: links.signIn },
      ],
    },
  ];
  return (
    <footer className="site-footer">
      <div className="container site-footer-inner">
        <div className="footer-brand">
          <Logo />
          <p>Intelligent Living. Unified Operations.</p>
          <p className="footer-copy">© {new Date().getFullYear()} VEYRA</p>
        </div>
        {columns.map((col) => (
          <div key={col.heading} className="footer-col">
            <p className="overline">{col.heading}</p>
            <ul>
              {col.items.map((item) => (
                <li key={item.label}>
                  <a href={item.href}>{item.label}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </footer>
  );
}
