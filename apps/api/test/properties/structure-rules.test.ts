import { describe, expect, it } from 'vitest';
import {
  createBuildingSchema,
  createUnitSchema,
  structureListSchema,
  updatePropertySchema,
  updateUnitSchema,
} from '../../src/modules/properties/domain/structure-rules';

const unit = { number: '12B', type: 'APARTMENT' };
const BUILDING = '0193b5a2-7c1d-7e3f-8a9b-0c1d2e3f4a5b';
const FLOOR = '0193b5a2-7c1d-7e3f-8a9b-0c1d2e3f4a5c';

describe('decimal fields (never floats)', () => {
  it.each(['85', '85.5', '85.50', '0.01', '99999999.99'])('accepts area %s', (areaSqm) => {
    expect(createUnitSchema.safeParse({ ...unit, areaSqm }).success).toBe(true);
  });

  it.each(['0', '0.00', '-5', '85.555', '1e3', 'abc', '123456789'])(
    'rejects area %s',
    (areaSqm) => {
      expect(createUnitSchema.safeParse({ ...unit, areaSqm }).success).toBe(false);
    },
  );

  it('rejects JSON numbers, which would pass through floating point', () => {
    expect(createUnitSchema.safeParse({ ...unit, areaSqm: 85.5 }).success).toBe(false);
    expect(createUnitSchema.safeParse({ ...unit, shareRatio: 0.25 }).success).toBe(false);
  });

  it('allows share ratios with up to 6 decimals', () => {
    expect(createUnitSchema.safeParse({ ...unit, shareRatio: '0.012345' }).success).toBe(true);
    expect(createUnitSchema.safeParse({ ...unit, shareRatio: '0.0123456' }).success).toBe(false);
  });

  it('lets an update clear a measure with null', () => {
    expect(updateUnitSchema.parse({ areaSqm: null })).toEqual({ areaSqm: null });
  });
});

describe('unit placement', () => {
  it('requires a building for a floor', () => {
    const result = createUnitSchema.safeParse({ ...unit, floorId: FLOOR });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['floorId']);
    expect(
      createUnitSchema.safeParse({ ...unit, buildingId: BUILDING, floorId: FLOOR }).success,
    ).toBe(true);
  });

  it('allows units without a building (villas)', () => {
    expect(createUnitSchema.safeParse({ number: 'Villa 7', type: 'VILLA' }).success).toBe(true);
  });
});

describe('codes and updates', () => {
  it('normalises building codes to upper case', () => {
    expect(createBuildingSchema.parse({ name: 'Tower A', code: ' tower-a ' }).code).toBe('TOWER-A');
    expect(createBuildingSchema.safeParse({ name: 'X', code: 'tower a' }).success).toBe(false);
  });

  it('requires at least one field in an update', () => {
    expect(updatePropertySchema.safeParse({}).success).toBe(false);
    expect(updateUnitSchema.safeParse({}).success).toBe(false);
    expect(updatePropertySchema.parse({ currency: 'lkr' })).toEqual({ currency: 'LKR' });
  });

  it('lists active structure unless the archive is asked for', () => {
    expect(structureListSchema.parse({})).toMatchObject({ status: 'ACTIVE', limit: 50 });
    expect(structureListSchema.parse({ status: 'ARCHIVED' }).status).toBe('ARCHIVED');
  });
});
