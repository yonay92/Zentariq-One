# DATABASE_Part_01.md

# Zentariq One Database Architecture — Part 01

## Core SaaS, Users, Roles, Permissions, Sites

Version: 1.0  
Project: Zentariq One  
Purpose: Define the foundational database tables for multi-company SaaS architecture, authentication mapping, users, roles, permissions, and site access.

---

## 1. Database Design Principles

Zentariq One is designed as a multi-tenant SaaS platform.

Every tenant is represented by a `company`.

Every operational record must be isolated by `company_id`.

Most operational records must also include `site_id`.

Security must be enforced at the database level using Supabase Row Level Security (RLS).

### Global Rules

- Use UUID primary keys.
- Use `company_id` on all tenant-owned tables.
- Use `site_id` on site-specific operational tables.
- Use `created_at` and `updated_at` on all major tables.
- Use soft-delete fields where appropriate.
- Never hardcode company-specific values.
- Never rely only on frontend filtering for security.
- Supabase RLS is mandatory.

---

## 2. Table: companies

Represents each clinic, research organization, or customer using Zentariq One.

```sql
companies
- id uuid primary key
- name text not null
- legal_name text
- status text not null default 'active'
- subscription_plan text default 'standard'
- timezone text default 'America/New_York'
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Status Values

- active
- inactive
- suspended
- archived

### Notes

A company is the top-level tenant. No user from one company can access another company's data.

---

## 3. Table: company_settings

Stores configurable company preferences.

```sql
company_settings
- id uuid primary key
- company_id uuid references companies(id)
- logo_file_id uuid null
- primary_color text default '#2563eb'
- secondary_color text default '#64748b'
- default_timezone text default 'America/New_York'
- date_format text default 'MM/DD/YYYY'
- language text default 'en'
- enable_ai boolean default true
- enable_task_center boolean default true
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Purpose

Allows each company to customize branding and system behavior.

---

## 4. Table: company_modules

Controls which modules are enabled for each company.

```sql
company_modules
- id uuid primary key
- company_id uuid references companies(id)
- module_key text not null
- is_enabled boolean default true
- created_at timestamptz default now()
```

### Example Module Keys

- dashboard
- task_center
- studies
- subjects
- visits
- charts
- regulatory
- analytics
- clinical_intelligence
- business_rules
- enterprise_document_center

---

## 5. Table: profiles

Maps Supabase Auth users to Zentariq One users.

```sql
profiles
- id uuid primary key references auth.users(id)
- company_id uuid references companies(id)
- full_name text not null
- email text not null unique
- phone text
- avatar_file_id uuid null
- status text default 'active'
- last_login_at timestamptz
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Status Values

- active
- inactive
- pending_invite
- suspended

### Notes

Use `profiles.id` as the application user id. It should match `auth.users.id`.

---

## 6. Table: roles

Defines user roles inside each company.

```sql
roles
- id uuid primary key
- company_id uuid references companies(id)
- name text not null
- key text not null
- description text
- is_system_role boolean default false
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Initial Roles

- admin
- ceo
- crc
- data_entry
- regulatory
- pi

### Notes

Roles may be customized per company, but system roles should not be deleted.

---

## 7. Table: user_roles

Allows a user to have one or multiple roles.

```sql
user_roles
- id uuid primary key
- company_id uuid references companies(id)
- user_id uuid references profiles(id)
- role_id uuid references roles(id)
- created_at timestamptz default now()
```

### Example

A user can be both `admin` and `data_entry`.

---

## 8. Table: permissions

Global catalog of permissions.

```sql
permissions
- id uuid primary key
- key text not null unique
- module text not null
- description text
- created_at timestamptz default now()
```

### Example Permission Keys

- view_dashboard
- create_study
- edit_study
- create_subject
- edit_subject
- mark_chart_ready
- mark_chart_entered
- upload_regulatory_document
- edit_business_rules
- view_all_sites
- manage_users
- view_audit_logs
- force_archive_study — a deliberate override permission (see
  BUSINESS_RULES_02_Studies.md, Study Archive). Unlike other permissions, it
  is NOT included in the admin role's default "all permissions" grant
  (`CompanyService.provision()`, `bootstrap_admin.sql`) — a company owner
  must consciously enable it per-role from Settings > Roles.
- force_archive_site — same override pattern as `force_archive_study`,
  applied to Site Archive (see §10 Site Archive Rule below). Also excluded
  from the admin default grant.

---

## 9. Table: role_permissions

Connects roles with permissions.

```sql
role_permissions
- id uuid primary key
- company_id uuid references companies(id)
- role_id uuid references roles(id)
- permission_id uuid references permissions(id)
- allowed boolean default true
- created_at timestamptz default now()
```

---

## 10. Table: sites

Represents physical clinical sites.

```sql
sites
- id uuid primary key
- company_id uuid references companies(id)
- name text not null
- site_code text          -- displayed as "Site Number" in the UI
- principal_investigator text
- address text
- city text
- state text
- zip_code text
- phone text
- timezone text
- status text default 'active'
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Status Values

- active
- inactive
- closed (legacy — the Sites module UI only exposes Active/Inactive/Archived)
- archived

### Site Archive Rule

Mirrors the Study Archive rule (`BUSINESS_RULES_02_Studies.md`): archiving is
blocked if the site has one or more enrolled Subjects, unless the caller
holds `force_archive_site` (not granted to any role by default — enabled
per-role from Settings > Roles) and supplies a reason. Fully audit logged
(`site.archived`, including enrolled-subject count, forced flag, reason).
Archived sites are excluded from the default Sites list; the list's
Active / Archived / All filter controls visibility.

---

## 11. Table: user_sites

Controls which sites a user can access.

```sql
user_sites
- id uuid primary key
- company_id uuid references companies(id)
- user_id uuid references profiles(id)
- site_id uuid references sites(id)
- created_at timestamptz default now()
```

### Rule

A user can only access records from sites listed in `user_sites`, unless they have a permission such as `view_all_sites`.

### Bootstrap Rule

When the first site is created for a company, every user holding the `admin`
role is automatically inserted into `user_sites` for that site (see
`SiteService.create`). This makes the bootstrap administrator's site access
explicit and visible in Settings → Users, on top of the `view_all_sites`
permission bypass admins already have.

---

## 12. Suggested Indexes

```sql
create index idx_profiles_company on profiles(company_id);
create index idx_roles_company on roles(company_id);
create index idx_user_roles_user on user_roles(user_id);
create index idx_user_sites_user on user_sites(user_id);
create index idx_sites_company on sites(company_id);
```

---

## 13. RLS Strategy

### Company Isolation

A user can only access records where:

```sql
record.company_id = current_user.company_id
```

### Site Isolation

For site-specific tables:

```sql
record.site_id in (select site_id from user_sites where user_id = auth.uid())
```

or user has `view_all_sites`.

---

## 14. Implementation Notes for Claude

- Implement these tables first.
- Create seed data for the default roles.
- Create default permissions.
- Enable RLS on all tables.
- Add helper SQL functions to get current user company and permissions.
- Do not build modules until authentication, profiles, roles, and sites are working.
