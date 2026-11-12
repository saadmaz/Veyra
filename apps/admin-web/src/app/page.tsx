import { Organisations } from '@/components/organisations';
import { StaffGate } from '@/components/staff-gate';

/** Platform Admin home: organisations and your support requests, for VEYRA staff only. */
export default function AdminHomePage() {
  return (
    <div className="shell shell--top">
      <StaffGate>
        <Organisations />
      </StaffGate>
    </div>
  );
}
