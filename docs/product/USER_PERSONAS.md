# User Personas

A person may hold several roles and relationships at once, across properties and organisations.
Roles and access scopes are modelled independently from a person's identity
(see [ACCESS_CONTROL](../security/ACCESS_CONTROL.md)).

| Persona | Primary surface | Goals | Typical capabilities | Restrictions |
| ------- | --------------- | ----- | -------------------- | ------------ |
| Platform operator | Platform admin | Onboard customers, keep the platform healthy | Provision organisations, platform support and configuration | No routine access to customer content; support access approved, time-boxed and audited |
| Organisation administrator | Console | Run the organisation's properties consistently | Organisation settings, assigned properties, staff and roles | Cannot access other organisations |
| Property manager | Console | Keep daily operations on track at their property | Property operations, residents, visitors, maintenance, facilities, announcements | Scope limited to assigned properties |
| Committee member | Console / Resident | Oversee finances and decisions transparently | Reports, approvals, votes on configured matters | No automatic access to residents' private documents |
| Finance officer | Console | Bill correctly, collect and reconcile | Billing, payments, reconciliation, finance reports | No unrelated security or identity-document access |
| Security supervisor / guard | Operations | Process arrivals fast without mistakes | Visitor processing, access logs, incidents | No financial or unrelated resident records |
| Maintenance supervisor / technician | Operations | Know what to fix, where, and close it out | Assigned work orders, inspections, task updates | No broad resident or finance access |
| Owner | Resident | Manage their unit, bills and household easily | Authorised units, bills, documents, requests, household invitations | Only units and records they are granted |
| Tenant | Resident | Use building services during their tenancy | Resident services for the active tenancy | No owner-only records or governance rights unless separately granted |
| Household member | Resident | Do everyday tasks on behalf of the household | Services delegated by the owner or tenant | Only the delegated permission set |
| Vendor / contractor | Vendor portal | Receive and complete assigned jobs | Assigned work, limited site and schedule details | Only explicitly assigned jobs and minimum necessary information |

## Design implications

- **Residents**: simple, task-oriented flows on mobile; no office visits for common tasks.
- **Security staff**: fast, low-error gate workflows on tablets, with variable connectivity and
  explicit offline contingency.
- **Finance**: correctness, reconciliation and traceability over speed of data entry.
- **Managers**: clear status of the community and the work queue, with role-scoped dashboards.
