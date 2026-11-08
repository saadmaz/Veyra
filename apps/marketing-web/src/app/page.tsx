const surfaces = [
  {
    name: 'VEYRA Console',
    body: 'One place for property managers, finance teams and committees to run the community.',
  },
  {
    name: 'VEYRA Resident',
    body: 'A mobile app for owners and tenants: visitors, requests, bookings, bills and notices.',
  },
  {
    name: 'VEYRA Operations',
    body: 'Fast, low-error tools for security and maintenance staff on the ground.',
  },
];

const principles = [
  'Each organisation’s data is isolated from every other',
  'Financial records you can trace and trust',
  'Built for many currencies, languages and time zones',
  'Accessible on every screen size',
];

export default function HomePage() {
  const contactEmail = process.env.NEXT_PUBLIC_CONTACT_EMAIL;

  return (
    <main>
      <header className="hero">
        <p className="eyebrow">VEYRA</p>
        <h1>Intelligent Living. Unified Operations.</h1>
        <p className="lede">
          The operating platform for condominiums, residential communities and property management
          organisations.
        </p>
        {contactEmail ? (
          <a className="button" href={`mailto:${contactEmail}`}>
            Talk to us
          </a>
        ) : null}
      </header>

      <section className="section" aria-labelledby="surfaces">
        <h2 id="surfaces">One platform, every role</h2>
        <div className="grid">
          {surfaces.map((s) => (
            <article key={s.name} className="card">
              <h3>{s.name}</h3>
              <p>{s.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section" aria-labelledby="principles">
        <h2 id="principles">Built on trust</h2>
        <ul className="list">
          {principles.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </section>

      <footer className="footer">© {new Date().getFullYear()} VEYRA</footer>
    </main>
  );
}
