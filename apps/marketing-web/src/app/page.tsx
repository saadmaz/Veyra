import Image from 'next/image';
import productConsole from '../assets/product-console.png';
import { Icon, type IconName } from '../components/icon';
import { SiteFooter, SiteHeader } from '../components/site-chrome';
import { contactAction } from '../lib/links';

const roles: { icon: IconName; label: string }[] = [
  { icon: 'briefcase', label: 'Property managers' },
  { icon: 'wallet', label: 'Finance officers' },
  { icon: 'landmark', label: 'Committees' },
  { icon: 'shield', label: 'Security teams' },
  { icon: 'wrench', label: 'Technicians' },
  { icon: 'home', label: 'Owners & tenants' },
];

const surfaces: { name: string; body: string; icon: IconName; points: string[] }[] = [
  {
    name: 'VEYRA Console',
    body: 'One place for property managers, finance teams and committees to run the community.',
    icon: 'grid',
    points: ['Ledger-backed finance', 'Approvals & governance', 'Portfolio reporting'],
  },
  {
    name: 'VEYRA Resident',
    body: 'A mobile app for owners and tenants: visitors, requests, bookings, bills and notices.',
    icon: 'home',
    points: ['QR visitor passes', 'Pay and track bills', 'Book shared facilities'],
  },
  {
    name: 'VEYRA Operations',
    body: 'Fast, low-error tools for security and maintenance staff on the ground.',
    icon: 'shield',
    points: ['Gate scan & walk-ins', 'Work orders with evidence', 'Shift handovers'],
  },
];

const modules: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'users',
    title: 'Residents & units',
    body: 'Effective-dated ownership, tenancy and households.',
  },
  {
    icon: 'qr',
    title: 'Visitors & access',
    body: 'Time-limited, revocable passes and a gate console.',
  },
  {
    icon: 'wallet',
    title: 'Finance & billing',
    body: 'Immutable ledger, reversals, multi-currency.',
  },
  { icon: 'wrench', title: 'Maintenance', body: 'Requests, work orders, SLAs and evidence.' },
  { icon: 'calendar', title: 'Facilities', body: 'Availability, fees, deposits and approvals.' },
  { icon: 'megaphone', title: 'Communications', body: 'Targeted notices with delivery tracking.' },
  { icon: 'landmark', title: 'Governance', body: 'Committees, meetings, motions and votes.' },
  { icon: 'box', title: 'Assets', body: 'Registers and preventive maintenance.' },
];

const principles: { icon: IconName; text: string }[] = [
  { icon: 'lock', text: 'Each organisation’s data is isolated from every other' },
  { icon: 'file', text: 'Financial records you can trace and trust' },
  { icon: 'globe', text: 'Built for many currencies, languages and time zones' },
  { icon: 'users', text: 'Accessible on every screen size' },
];

const outcomes = [
  { value: '1 record', label: 'for every unit, person and payment' },
  { value: '0 edits', label: 'to posted ledger entries, only reversals' },
  { value: '24/7', label: 'gate operations with audited decisions' },
  { value: 'WCAG 2.2 AA', label: 'accessibility target on every surface' },
];

export default function HomePage() {
  const cta = contactAction();

  return (
    <>
      <SiteHeader />
      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="container hero-inner">
            <p className="pill">
              <Icon name="sparkle" size={14} />
              Property operations, re-engineered
            </p>
            <h1 id="hero-title">
              Intelligent Living.
              <br />
              Unified Operations.
            </h1>
            <p className="lede">
              The operating platform for condominiums, residential communities and property
              management organisations. One secure system for managers, residents, security and
              maintenance teams.
            </p>
            <div className="hero-actions">
              <a href={cta.href} className="button button-primary button-lg">
                {cta.label}
              </a>
              <a href="#product" className="button button-secondary button-lg">
                See the product
              </a>
            </div>
            <div className="product-shot">
              <Image
                src={productConsole}
                alt="The VEYRA Console overview: occupancy, collections, overdue balance, open work orders, a collections chart, approvals and live gate activity."
                priority
                sizes="(max-width: 1240px) 100vw, 1180px"
              />
            </div>
          </div>
        </section>

        <section className="roles" aria-label="Who VEYRA is for">
          <div className="container roles-inner">
            <p className="overline">Built for every role in the community</p>
            <ul>
              {roles.map((r) => (
                <li key={r.label}>
                  <Icon name={r.icon} size={18} />
                  {r.label}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="product" className="section" aria-labelledby="surfaces-title">
          <div className="container">
            <p className="overline accent">One platform, every role</p>
            <h2 id="surfaces-title" className="display">
              Three focused experiences.
              <br />
              One source of truth.
            </h2>
            <div className="surface-grid">
              {surfaces.map((s) => (
                <article key={s.name} className="surface-card">
                  <span className="icon-badge">
                    <Icon name={s.icon} size={22} />
                  </span>
                  <h3>{s.name}</h3>
                  <p>{s.body}</p>
                  <ul className="check-list">
                    {s.points.map((p) => (
                      <li key={p}>
                        <Icon name="check" size={16} />
                        {p}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="modules" className="section section-surface" aria-labelledby="modules-title">
          <div className="container">
            <div className="section-head">
              <div>
                <p className="overline accent">Everything a community runs on</p>
                <h2 id="modules-title" className="display">
                  Modules that work as one.
                </h2>
              </div>
              <p className="section-aside">
                Each module owns its domain, shares one permission model and writes to one audited
                record.
              </p>
            </div>
            <ul className="module-grid">
              {modules.map((m) => (
                <li key={m.title} className="module-card">
                  <span className="icon-badge icon-badge-surface">
                    <Icon name={m.icon} size={20} />
                  </span>
                  <h3>{m.title}</h3>
                  <p>{m.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="trust" className="section section-ink" aria-labelledby="trust-title">
          <div className="container trust-inner">
            <div>
              <p className="overline">Built on trust</p>
              <h2 id="trust-title" className="display">
                Security and data integrity are the product, not a feature.
              </h2>
              <p className="trust-body">
                VEYRA is designed from the tenant model up. We do not claim certifications we have
                not earned; we show you how the system works.
              </p>
            </div>
            <ul className="trust-list">
              {principles.map((p) => (
                <li key={p.text}>
                  <span className="glass-badge">
                    <Icon name={p.icon} size={20} />
                  </span>
                  {p.text}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="section outcomes" aria-label="Outcomes">
          <div className="container">
            <ul className="outcome-grid">
              {outcomes.map((o) => (
                <li key={o.value}>
                  <strong>{o.value}</strong>
                  <span>{o.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="cta" aria-labelledby="cta-title">
          <div className="container">
            <div className="cta-band">
              <div>
                <h2 id="cta-title">Bring your community onto one platform.</h2>
                <p>
                  Tell us about your properties. We will show you VEYRA with your own structure.
                </p>
              </div>
              <a href={cta.href} className="button button-on-ink button-lg">
                {cta.label}
              </a>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
