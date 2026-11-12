/**
 * The trades of maintenance work (Phase 7) and of the vendors who do it (Phase 9). The database
 * enum MaintenanceCategory holds the same values.
 */
export const TRADES = [
  'PLUMBING',
  'ELECTRICAL',
  'HVAC',
  'APPLIANCE',
  'STRUCTURAL',
  'CARPENTRY',
  'PAINTING',
  'PEST_CONTROL',
  'CLEANING',
  'LIFT',
  'SECURITY_SYSTEM',
  'OTHER',
] as const;

export type Trade = (typeof TRADES)[number];
