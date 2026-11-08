/**
 * Migration 037 — structural regression tests.
 *
 * Same caveat as the migration-033/035 suites: these assert the migration's
 * own SQL text, not live Postgres behavior. Live behavioral proof (two
 * tenants, two sites, site-restricted/inactive/suspended users, forged
 * reviewer and cross-tenant attempts, legacy-grant replay, PostgREST
 * end-to-end) lives in the G7 RLS hardening report, not here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(__dirname, '../../../supabase/migrations');
const MIGRATION_PATH = resolve(MIGRATIONS_DIR, '037_rls_hardening.sql');

let sql: string;
let body: string;

function functionBody(name: string): string {
  const match = body.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`),
  );
  expect(match, `function ${name}`).not.toBeNull();
  return match![0];
}

beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf8').replace(/\r\n/g, '\n');
  // Statements only: strip full-line comments so assertions never match prose.
  body = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
});

describe('migration 037 — atomicity and preconditions', () => {
  it('has a unique migration number that directly follows 036', () => {
    const numbers = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .map((f) => f.slice(0, 3));
    expect(numbers.filter((n) => n === '037')).toHaveLength(1);
    expect(numbers).toContain('036');
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('runs in a single transaction', () => {
    expect(body.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(body.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(body.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(body.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('refuses to run before migration 036 and on existing cross-company references', () => {
    expect(body).toContain("has_table_privilege('authenticated', 'public.profiles', 'SELECT')");
    expect(body).toContain('user_roles row(s) reference a role of another company');
    expect(body).toContain('role_permissions row(s) reference a role of another company');
    expect(body).toContain('user_roles row(s) reference a user of another company');
    expect(body).toContain('user_sites row(s) reference a user or site of another company');
  });

  it('never grants anything to anon or PUBLIC', () => {
    expect(body).not.toMatch(/GRANT[^;]*TO[^;]*\b(anon|PUBLIC)\b/i);
  });

  it('pins search_path on every SECURITY DEFINER function it defines', () => {
    const definers = body.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/g) ?? [];
    const secdef = definers.filter((f) => f.includes('SECURITY DEFINER'));
    expect(secdef.length).toBeGreaterThanOrEqual(11);
    for (const f of secdef) expect(f).toContain('SET search_path = public, pg_temp');
  });
});

describe('migration 037 — H1 deactivated users', () => {
  it('current_company_id() resolves only for an active user of an active company', () => {
    const fn = functionBody('current_company_id');
    expect(fn).toContain("p.status = 'active'");
    expect(fn).toContain("c.status = 'active'");
    expect(fn).toContain('JOIN public.companies c ON c.id = p.company_id');
  });

  it('lets a user read only their own profile row regardless of status', () => {
    expect(body).toMatch(
      /CREATE POLICY "profiles_select_own" ON profiles\s+FOR SELECT USING \(id = auth\.uid\(\)\);/,
    );
  });

  it('guards identity fields and status on every Data API profile update', () => {
    const fn = functionBody('enforce_profile_update_integrity');
    expect(fn).toContain("current_user NOT IN ('authenticated', 'anon')");
    for (const col of ['id', 'company_id', 'email', 'created_at']) {
      expect(fn).toContain(`NEW.${col} IS DISTINCT FROM OLD.${col}`);
    }
    expect(fn).toContain('users cannot change their own account status');
    expect(fn).toContain("has_permission('manage_users')");
    expect(fn).toContain("'pending_invite'");
    expect(fn).toContain('NEW.last_login_at := now()');
    expect(body).toMatch(
      /CREATE TRIGGER trg_profiles_enforce_update_integrity\s+BEFORE UPDATE ON profiles/,
    );
  });

  it('scopes can_access_site() user_sites rows to the current company', () => {
    expect(functionBody('can_access_site')).toContain('AND company_id = current_company_id()');
  });
});

describe('migration 037 — M1 same-company role and site references', () => {
  it('replaces each single-column FK with a same-named composite FK', () => {
    const fks: Array<[string, string, string]> = [
      [
        'role_permissions',
        'role_permissions_role_id_fkey',
        'FOREIGN KEY (role_id, company_id) REFERENCES roles (id, company_id)',
      ],
      [
        'user_roles',
        'user_roles_role_id_fkey',
        'FOREIGN KEY (role_id, company_id) REFERENCES roles (id, company_id)',
      ],
      [
        'user_roles',
        'user_roles_user_id_fkey',
        'FOREIGN KEY (user_id, company_id) REFERENCES profiles (id, company_id)',
      ],
      [
        'user_sites',
        'user_sites_user_id_fkey',
        'FOREIGN KEY (user_id, company_id) REFERENCES profiles (id, company_id)',
      ],
      [
        'user_sites',
        'user_sites_site_id_fkey',
        'FOREIGN KEY (site_id, company_id) REFERENCES sites (id, company_id)',
      ],
    ];
    for (const [, name, def] of fks) {
      expect(body).toContain(`DROP CONSTRAINT ${name},`);
      expect(body).toMatch(
        new RegExp(`ADD CONSTRAINT ${name}\\s+${def.replace(/[()]/g, '\\$&')} ON DELETE CASCADE`),
      );
    }
    for (const t of ['roles', 'profiles', 'sites']) {
      expect(body).toMatch(
        new RegExp(
          `ALTER TABLE ${t}\\s+ADD CONSTRAINT uq_${t}_id_company\\s+UNIQUE \\(id, company_id\\)`,
        ),
      );
    }
  });

  it('has_permission() only counts role permissions recorded in the same company', () => {
    const fn = functionBody('has_permission');
    expect(fn).toContain('JOIN roles r ON r.id = ur.role_id AND r.company_id = ur.company_id');
    expect(fn).toContain('rp.role_id = ur.role_id AND rp.company_id = ur.company_id');
    expect(fn).toContain('ur.company_id = current_company_id()');
  });
});

describe('migration 037 — M2 company settings', () => {
  it('drops the permission-less UPDATE policy and adds a manage_settings INSERT policy', () => {
    expect(body).toContain('DROP POLICY "company_settings_update" ON company_settings;');
    expect(body).toMatch(
      /CREATE POLICY "company_settings_insert_admin" ON company_settings\s+FOR INSERT WITH CHECK \(\s+company_id = current_company_id\(\)\s+AND has_permission\('manage_settings'\)\s+\);/,
    );
    expect(body).toContain('GRANT INSERT ON public.company_settings TO authenticated;');
    expect(body).not.toMatch(/DROP POLICY "company_settings_update_admin"/);
  });
});

describe('migration 037 — M3 site isolation of the 15 child tables', () => {
  const expected: Array<[string, string[], string]> = [
    [
      'subject_notes',
      ['subject_notes_select', 'subject_notes_insert'],
      'can_access_subject(subject_id)',
    ],
    [
      'subject_documents',
      ['subject_documents_select', 'subject_documents_insert'],
      'can_access_subject(subject_id)',
    ],
    [
      'subject_status_history',
      ['subject_status_history_select', 'subject_status_history_insert'],
      'can_access_subject(subject_id)',
    ],
    [
      'subject_timeline',
      ['subject_timeline_select', 'subject_timeline_insert'],
      'can_access_subject(subject_id)',
    ],
    ['visit_notes', ['visit_notes_select', 'visit_notes_insert'], 'can_access_visit(visit_id)'],
    [
      'chart_metrics',
      ['chart_metrics_select', 'chart_metrics_insert', 'chart_metrics_update'],
      'can_access_chart(chart_id)',
    ],
    ['lead_calls', ['lead_calls_select', 'lead_calls_insert'], 'can_access_lead(lead_id)'],
    [
      'lead_contact_log',
      ['lead_contact_log_select', 'lead_contact_log_insert'],
      'can_access_lead(lead_id)',
    ],
    [
      'lead_notes',
      ['lead_notes_select', 'lead_notes_insert', 'lead_notes_update'],
      'can_access_lead(lead_id)',
    ],
    [
      'lead_prescreenings',
      ['lead_prescreenings_select', 'lead_prescreenings_insert', 'lead_prescreenings_update'],
      'can_access_lead(lead_id)',
    ],
    [
      'lead_prescreening_answers',
      ['prescreening_answers_select', 'prescreening_answers_insert'],
      'can_access_lead_prescreening(lead_prescreening_id)',
    ],
    [
      'lead_status_history',
      ['lead_status_history_select', 'lead_status_history_insert'],
      'can_access_lead(lead_id)',
    ],
    [
      'lead_duplicate_dismissals',
      ['lead_duplicate_dismissals_select', 'lead_duplicate_dismissals_insert'],
      'can_access_lead(matched_lead_id)',
    ],
    [
      'document_versions',
      ['document_versions_select', 'document_versions_insert', 'document_versions_update'],
      'can_access_document_parent(document_id, staff_document_id)',
    ],
    [
      'document_history',
      ['document_history_select', 'document_history_insert'],
      'can_access_document_parent(document_id, staff_document_id)',
    ],
  ];

  it.each(expected)('%s policies require parent site access', (table, policies, predicate) => {
    for (const policy of policies) {
      const match = body.match(new RegExp(`ALTER POLICY "${policy}" ON ${table}[\\s\\S]*?;`));
      expect(match, policy).not.toBeNull();
      expect(match![0]).toContain(predicate);
      expect(match![0]).toContain('company_id = current_company_id()');
    }
  });

  it('parent helpers check company and site for the caller only', () => {
    const helpers: Array<[string, string]> = [
      ['can_access_subject', 'can_access_site(s.site_id)'],
      ['can_access_visit', 'can_access_site(v.site_id)'],
      ['can_access_chart', 'can_access_site(c.site_id)'],
      ['can_access_lead', 'l.site_id IS NULL OR can_access_site(l.site_id)'],
    ];
    for (const [fn, site] of helpers) {
      const def = functionBody(fn);
      expect(def).toContain('company_id = current_company_id()');
      expect(def).toContain(site);
      expect(def).toContain('STABLE');
    }
  });
});

describe('migration 037 — M5 document review integrity', () => {
  it('enforces reviewer attribution, DB-clock timestamps and allowed transitions', () => {
    const fn = functionBody('enforce_document_version_integrity');
    expect(fn).toContain('NEW.reviewed_by := v_uid;');
    expect(fn).toContain('NEW.reviewed_at := now();');
    expect(fn).toContain('NEW.uploaded_at := now();');
    expect(fn).toContain('reviewed_by must be the current user');
    expect(fn).toContain("THEN 'edit_regulatory_document'");
    expect(fn).toContain("ELSE 'manage_staff_credentials'");
    expect(fn).toContain(
      "OLD.status IN ('pending_review', 'approved') AND NEW.status IN ('superseded', 'archived')",
    );
    expect(fn).toContain("IF OLD.status <> 'pending_review' THEN");
    expect(fn).toContain('a version cannot be made current again');
    for (const col of ['file_id', 'checksum', 'version', 'uploaded_by', 'previous_version_id']) {
      expect(fn).toContain(`NEW.${col} IS DISTINCT FROM OLD.${col}`);
    }
    expect(body).toMatch(
      /CREATE TRIGGER trg_document_versions_enforce_integrity\s+BEFORE INSERT OR UPDATE ON document_versions/,
    );
  });

  it('records the caller on every document_history entry', () => {
    const fn = functionBody('enforce_document_history_attribution');
    expect(fn).toContain('NEW.changed_by := auth.uid();');
    expect(fn).toContain('NEW.changed_at := now();');
  });

  it('ties every regulatory document status change to its permission and version workflow', () => {
    const fn = functionBody('enforce_regulatory_document_integrity');
    expect(fn).toContain("IF current_user NOT IN ('authenticated', 'anon') THEN");
    // INSERT: starts unreviewed, attributed to the caller, with no version data.
    expect(fn).toContain("IF NEW.status NOT IN ('missing', 'draft') THEN");
    expect(fn).toContain('uploaded_by must be the current user');
    // UPDATE: identity and scope immutable; denormalized fields mirror the current version.
    for (const col of ['company_id', 'site_id', 'study_id', 'document_type_id', 'uploaded_by']) {
      expect(fn).toContain(`NEW.${col} IS DISTINCT FROM OLD.${col}`);
    }
    expect(fn).toContain('must match the current version');
    expect(fn).toContain("has_permission('override_regulatory_status')");
    expect(fn).toContain("has_permission('archive_regulatory_document')");
    expect(fn).toContain("has_permission('upload_regulatory_document')");
    expect(fn).toContain("v_current.status IS DISTINCT FROM 'pending_review'");
    // Approval needs an approved current version and edit_regulatory_document.
    expect(fn).toContain("ELSIF NEW.status IN ('current', 'expiring_soon', 'expired') THEN");
    expect(fn).toContain("v_current.status IS DISTINCT FROM 'approved'");
    expect(fn).toContain("has_permission('edit_regulatory_document')");
    expect(fn).toContain("dv.status = 'rejected' AND dv.reviewed_by = v_uid");
    // Anything else (e.g. expiry recomputation) is refused for Data API callers.
    expect(fn).toMatch(/ELSE\s+RAISE EXCEPTION 'regulatory_documents: invalid status transition/);
    expect(body).toMatch(
      /CREATE TRIGGER trg_regulatory_documents_enforce_integrity\s+BEFORE INSERT OR UPDATE ON regulatory_documents/,
    );
  });
});

describe('migration 037 — L1 / L2 / L5', () => {
  it('tasks_insert compares the assignee company with the task company', () => {
    const policy = body.match(/ALTER POLICY "tasks_insert" ON tasks[\s\S]*?\);\n/);
    expect(policy).not.toBeNull();
    expect(policy![0]).toContain('pr.id = tasks.assigned_to AND pr.company_id = tasks.company_id');
    expect(policy![0]).not.toMatch(/pr\.company_id = company_id\b/);
  });

  it('user_has_site_access() evaluates the target user inside their own company', () => {
    const fn = functionBody('user_has_site_access');
    expect(fn).toContain('pr.company_id = us.company_id');
    expect(fn).toContain('rp.company_id = ur.company_id');
    expect(fn).toContain('s.company_id = ur.company_id');
  });

  it('limits notification updates to the read-state columns', () => {
    expect(body).toContain('REVOKE UPDATE ON public.notifications FROM authenticated;');
    expect(body).toContain(
      'GRANT UPDATE (is_read, read_at) ON public.notifications TO authenticated;',
    );
  });

  it('removes PUBLIC/anon EXECUTE from the RLS helpers and keeps it for authenticated', () => {
    const revoke = body.match(/REVOKE ALL ON FUNCTION[\s\S]*?FROM PUBLIC, anon;/);
    const grant = body.match(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO authenticated, service_role;/);
    expect(revoke).not.toBeNull();
    expect(grant).not.toBeNull();
    for (const fn of [
      'current_company_id()',
      'has_permission(text)',
      'can_access_site(uuid)',
      'complete_visit_with_chart(uuid, uuid, uuid, text)',
    ]) {
      expect(revoke![0]).toContain(`public.${fn}`);
      expect(grant![0]).toContain(`public.${fn}`);
    }
  });
});
