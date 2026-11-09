'use client';

import type { PersonDto } from '@veyra/api-contracts';
import { SelectField } from './ui';

/**
 * Native select of the people property staff may pick (GET …/properties/:id/persons): residents
 * of the property and profiles not yet attached anywhere.
 */
export function PersonSelect({
  label,
  name,
  people,
  required = true,
  emptyLabel = 'Choose a resident',
  error,
}: {
  label: string;
  name: string;
  people: PersonDto[];
  required?: boolean;
  emptyLabel?: string;
  error?: string | undefined;
}) {
  return (
    <SelectField label={label} name={name} defaultValue="" required={required} error={error}>
      <option value="">{emptyLabel}</option>
      {people.map((person) => (
        <option key={person.id} value={person.id}>
          {person.fullName}
          {person.email ? ` (${person.email})` : ''}
        </option>
      ))}
    </SelectField>
  );
}
