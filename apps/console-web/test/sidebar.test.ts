import { describe, expect, it } from 'vitest';
import { activeHref, routeIds, sidebarGroups } from '../src/lib/sidebar';

const property = '/organisations/o1/properties/p1';

describe('sidebar', () => {
  it('reads organisation and property ids, ignoring the "new" pages', () => {
    expect(routeIds(`${property}/finance/invoices`)).toEqual({
      organisationId: 'o1',
      propertyId: 'p1',
    });
    expect(routeIds('/organisations/new')).toEqual({});
    expect(routeIds('/organisations/o1/properties/new')).toEqual({ organisationId: 'o1' });
  });

  it('shows only account links outside an organisation', () => {
    expect(sidebarGroups('/organisations').map((g) => g.label)).toEqual(['Account']);
  });

  it('adds property, workspace and organisation groups inside a property', () => {
    const groups = sidebarGroups(`${property}/residents`);
    expect(groups.map((g) => g.label)).toEqual([
      'Property',
      'My workspace',
      'Organisation',
      'Account',
    ]);
    expect(groups[0]?.items[0]?.href).toBe(property);
  });

  it('marks the most specific link active', () => {
    const groups = sidebarGroups(`${property}/finance/invoices/i1`);
    expect(activeHref(`${property}/finance/invoices/i1`, groups)).toBe(`${property}/finance`);
    expect(activeHref(property, groups)).toBe(property);
    expect(activeHref('/organisations/o1/vendors/v1', sidebarGroups('/organisations/o1'))).toBe(
      '/organisations/o1/vendors',
    );
  });
});
