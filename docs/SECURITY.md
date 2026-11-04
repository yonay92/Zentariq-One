# SECURITY.md

# Zentariq One Security Specification

Version: 1.0  
Project: Zentariq One  
Purpose: Define the complete security architecture for Zentariq One.

---

## 1. Security Philosophy

Zentariq One is designed for clinical research operations and must protect sensitive operational, regulatory, subject, staff, study and document data.

Security is not a frontend feature.

Security must be enforced at:

- Database level
- API level
- Service layer
- Storage layer
- AI layer
- Audit layer

The frontend may improve user experience, but it must never be trusted as the primary security boundary.

---

## 2. Core Security Rules

1. Every user belongs to one Company.
2. Every Company is isolated from every other Company.
3. Most operational data is also restricted by Site.
4. Permissions are role-based.
5. Some access is field-level.
6. Storage is private.
7. AI cannot access unauthorized data.
8. Every critical action is audited.
9. Production data changes require authorization.
10. RLS must never be disabled.

---

## 3. Multi-Tenant Isolation

Zentariq One is a SaaS platform.

Each tenant is represented by `company_id`.

Every major table must include `company_id`.

Examples:

- profiles
- sites
- studies
- subjects
- visits
- charts
- tasks
- files
- regulatory_documents
- business_rules
- audit_logs

### Rule

A user can only access records where:

```sql
record.company_id = current_user.company_id
```

There must be no cross-company visibility.

---

## 4. Site-Based Access

Most operational work happens inside Sites.

Site-controlled tables include:

- subjects
- visits
- charts
- calendar_events
- regulatory_documents
- tasks
- staff_documents
- analytics_kpis

### Rule

A user can only access a site-specific record if:

- the record belongs to the user's company
- and the record site is in the user's authorized sites
- or the user has permission `view_all_sites`

---

## 5. Role-Based Access Control

Initial roles:

- Admin
- CEO
- CRC
- Data Entry
- Regulatory
- PI

### Admin

Can manage:

- Users
- Sites
- Studies
- Settings
- Business Rules
- Security
- Audit Logs

### CEO

Can view:

- Executive dashboards
- Reports
- Site performance
- Study performance

Usually read-only.

### CRC

Can manage:

- Subjects
- Visits
- Notes
- Chart Ready status
- Manual calendar events allowed by permissions

### Data Entry

Can manage:

- Chart queue
- Chart status
- Entered in EDC
- Chart comments

### Regulatory

Can manage:

- Regulatory documents
- Staff documents
- Binders
- Expiration tracking

### PI

Can view:

- Assigned studies
- Related subjects
- Related regulatory information if permitted

---

## 6. Permission Model

Permissions must be granular.

Examples:

- view_subjects
- create_subject
- edit_subject
- view_charts
- mark_chart_ready
- mark_chart_entered
- upload_documents
- manage_business_rules
- view_audit_logs
- manage_users
- view_all_sites

Permissions are assigned to Roles.

Users may have multiple Roles.

---

## 7. Field-Level Protection

Some fields are visible but not editable by certain roles.

Example: Chart EDC completion fields.

CRC may view:

- entered_in_edc_date
- entered_by
- days_until_entry

But cannot edit those fields after Data Entry completes the chart.

Only:

- Data Entry
- Admin
- Authorized CRC if permitted

can mark a chart as Entered in EDC.

---

## 8. Supabase Row Level Security

Enable RLS on every business table.

Required helper functions:

```sql
current_company_id()
current_user_sites()
has_permission(permission_key text)
can_access_site(site_id uuid)
```

### Example Policy Pattern

```sql
company_id = current_company_id()
```

For site-based tables:

```sql
company_id = current_company_id()
AND (
  site_id IN (select site_id from user_sites where user_id = auth.uid())
  OR has_permission('view_all_sites')
)
```

---

## 9. API Security

Every API request must:

1. Validate authentication.
2. Resolve current user.
3. Resolve company.
4. Resolve roles.
5. Resolve permissions.
6. Validate site access.
7. Validate request payload.
8. Execute service logic.
9. Write audit log if required.

Never trust client-provided `company_id`.

The backend must derive company from the authenticated user.

---

## 10. File Security

All storage buckets must be private.

No permanent public URLs.

Use signed URLs with expiration.

File access requires:

- company match
- site access if applicable
- module permission
- record relationship validation

### Buckets

- protocols
- regulatory
- subjects
- studies
- avatars
- reports
- exports
- ai-temp

---

## 11. AI Security

Clinical Intelligence must obey the same security model as users.

AI may only analyze data that the requesting user is authorized to access.

AI must never:

- access another company
- bypass RLS
- write production data without approval
- invent source records
- expose hidden fields
- execute destructive actions without confirmation

AI outputs that change data must be stored as pending review.

---

## 12. Audit Trail

Audit every critical action.

Examples:

- login
- user creation
- permission changes
- study creation
- protocol upload
- AI approval
- subject status changes
- visit completion
- chart entered in EDC
- document archive
- business rule changes

Audit logs are immutable.

Users cannot edit audit logs.

---

## 13. Authentication Hardening

Requirements:

- Email verification
- Password reset
- Session expiration
- Secure cookies
- MFA ready architecture
- Future SSO support

Admin accounts should support MFA in future versions.

---

## 14. Input Validation

Validate all inputs server-side.

Required:

- string length limits
- date validation
- UUID validation
- file type validation
- file size validation
- enum validation
- permission validation

Never depend only on frontend validation.

---

## 15. Rate Limiting

Apply rate limits to:

- login attempts
- password reset
- AI requests
- file uploads
- report exports
- search endpoints

---

## 16. Data Retention

Zentariq One should support data retention rules per Company.

Future capabilities:

- archive old studies
- preserve audit logs
- export company data
- deactivate users without deleting history

---

## 17. Security Monitoring

Track:

- failed logins
- unusual access patterns
- excessive downloads
- AI usage spikes
- repeated forbidden requests
- permission changes
- service role usage

---

## 18. Service Role Key

The Supabase service role key must never be exposed to the frontend.

It may only be used in secure server environments:

- Supabase Edge Functions
- Next.js server routes
- controlled backend services

---

## 19. Production Security Checklist

Before production:

- RLS enabled on all tables
- Storage buckets private
- signed URLs tested
- service role key protected
- audit logs working
- role permissions validated
- site filtering validated
- company isolation tested
- AI access restrictions tested
- backup enabled
- error logging enabled

---

## 20. Final Rule

Security is part of the architecture, not a feature to add later.

Zentariq One must be secure by default, auditable by design and scalable for enterprise SaaS deployment.
