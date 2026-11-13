import type { Metadata } from 'next';
import { Icon } from '../../components/icon';
import { PlanCards } from '../../components/plan-cards';
import { SiteFooter, SiteHeader } from '../../components/site-chrome';
import { contactAction, links } from '../../lib/links';
import { comparison, faqs } from '../../lib/pricing';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Simple per-unit pricing for VEYRA. Every plan includes the resident and staff apps.',
};

function Cell({ value }: { value: string }) {
  if (value === 'yes')
    return (
      <span className="cmp-yes">
        <Icon name="check" size={18} />
        <span className="visually-hidden">Included</span>
      </span>
    );
  if (value === 'no')
    return (
      <span className="cmp-no">
        —<span className="visually-hidden">Not included</span>
      </span>
    );
  return <>{value}</>;
}

export default function PricingPage() {
  const cta = contactAction();
  return (
    <>
      <SiteHeader />
      <main>
        <section className="pricing-head" aria-labelledby="pricing-title">
          <div className="container narrow center">
            <p className="overline accent">Pricing</p>
            <h1 id="pricing-title" className="display">
              Simple pricing per unit.
            </h1>
            <p className="lede">
              Pay for the homes you manage. Every plan includes the resident and staff apps. Prices
              exclude tax.
            </p>
          </div>
        </section>

        <section className="pricing-plans" aria-label="Plans">
          <div className="container">
            <PlanCards trialHref={links.signUp} salesHref={cta.href} />
          </div>
        </section>

        <section className="section-tight" aria-labelledby="compare-title">
          <div className="container">
            <h2 id="compare-title" className="h1">
              Compare plans
            </h2>
            <div className="table-wrap">
              <table className="compare">
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="visually-hidden">Feature</span>
                    </th>
                    <th scope="col">Starter</th>
                    <th scope="col">Growth</th>
                    <th scope="col">Enterprise</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.map((row) => (
                    <tr key={row.feature}>
                      <th scope="row">{row.feature}</th>
                      {row.values.map((v, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: fixed three-column row
                        <td key={i}>
                          <Cell value={v} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="section-tight faq" aria-labelledby="faq-title">
          <div className="container narrow">
            <h2 id="faq-title" className="h1">
              Frequently asked questions
            </h2>
            {faqs.map((f, i) => (
              <details key={f.q} open={i === 0}>
                <summary>
                  {f.q}
                  <span className="faq-chevron">
                    <Icon name="chevronDown" size={18} />
                  </span>
                </summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
