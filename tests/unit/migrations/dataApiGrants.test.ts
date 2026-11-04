/**
 * Migration 036 — Data API grant matrix, structural regression tests.
 *
 * What these tests do and do not prove: vitest never talks to a real
 * Postgres instance, so these assertions are made against the migration's
 * own SQL text (plus the policy definitions in migrations 001–035). They pin
 * the reviewed least-privilege matrix and the security constraints the G7
 * remediation required, so that a later edit cannot silently widen a grant,
 * expose a table to `anon`, or make an append-only ledger mutable.
 *
 * The behaviour itself (the post-login profile read succeeding, tenant
 * isolation, 42501 for unexposed operations, PostgREST end-to-end) was
 * verified once against an isolated local Supabase Postgres + PostgREST
 * replay of migrations 001–036 — see the PR A description for those results.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(__dirname, '../../../supabase/migrations');
const MIGRATION_FILE = '036_data_api_grants.sql';

type Role = 'authenticated' | 'service_role';
type Matrix = Record<string, Record<Role, string>>;

// The reviewed matrix (S = SELECT, I = INSERT, U = UPDATE, D = DELETE).
// Every one of the 66 public tables is listed, including those that are
// deliberately NOT exposed (empty strings). Changing this table is a security
// review decision, not a test fix.
const EXPECTED: Matrix = {
  appointment_confirmation_log: { authenticated: 'I', service_role: '' },
  appointment_confirmations: { authenticated: 'SIU', service_role: '' },
  audit_logs: { authenticated: 'I', service_role: 'I' },
  calendar_events: { authenticated: 'SIU', service_role: '' },
  chart_assignments: { authenticated: '', service_role: 'S' },
  chart_comments: { authenticated: 'SI', service_role: '' },
  chart_history: { authenticated: 'SI', service_role: '' },
  chart_metrics: { authenticated: 'SIU', service_role: '' },
  charts: { authenticated: 'SIU', service_role: 'S' },
  companies: { authenticated: 'S', service_role: '' },
  company_modules: { authenticated: 'S', service_role: 'SIU' },
  company_settings: { authenticated: 'SU', service_role: 'SIU' },
  document_history: { authenticated: 'SI', service_role: 'I' },
  document_types: { authenticated: 'SIU', service_role: 'SIU' },
  document_versions: { authenticated: 'SI', service_role: '' }, // + column-level UPDATE
  file_links: { authenticated: 'SID', service_role: 'SID' },
  files: { authenticated: 'SI', service_role: 'SU' },
  lead_calls: { authenticated: 'SI', service_role: '' },
  lead_contact_info: { authenticated: 'SIU', service_role: '' },
  lead_contact_log: { authenticated: 'SI', service_role: '' },
  lead_duplicate_dismissals: { authenticated: 'SIU', service_role: '' },
  lead_notes: { authenticated: 'SIU', service_role: '' },
  lead_prescreening_answers: { authenticated: 'SI', service_role: '' },
  lead_prescreenings: { authenticated: 'SIU', service_role: '' },
  lead_status_history: { authenticated: 'SI', service_role: '' },
  lead_tasks: { authenticated: 'SIU', service_role: '' },
  leads: { authenticated: 'SIU', service_role: '' },
  migration_reconciliation_log: { authenticated: '', service_role: '' },
  notification_email_queue: { authenticated: '', service_role: 'SIU' },
  notification_preferences: { authenticated: 'SIU', service_role: 'SI' },
  notifications: { authenticated: 'SU', service_role: 'SI' },
  permissions: { authenticated: 'S', service_role: 'S' },
  profiles: { authenticated: 'SU', service_role: 'SIU' },
  referral_sources: { authenticated: 'SIU', service_role: '' },
  regulatory_binders: { authenticated: '', service_role: '' },
  regulatory_documents: { authenticated: 'SIU', service_role: 'SU' },
  role_permissions: { authenticated: 'SIU', service_role: 'SIU' },
  roles: { authenticated: 'S', service_role: 'SI' },
  sites: { authenticated: 'SIU', service_role: 'S' },
  staff_documents: { authenticated: 'SIU', service_role: 'SU' },
  studies: { authenticated: 'SIU', service_role: '' },
  study_ai_extractions: { authenticated: 'SU', service_role: 'SI' },
  study_document_requirements: { authenticated: 'SIU', service_role: '' },
  study_documents: { authenticated: 'SI', service_role: '' },
  study_drafts: { authenticated: 'SIUD', service_role: 'SU' },
  study_prescreening_questions: { authenticated: 'SIU', service_role: '' },
  study_sites: { authenticated: 'SID', service_role: 'S' },
  study_staff: { authenticated: 'S', service_role: '' },
  subject_contact_info: { authenticated: 'SIU', service_role: 'I' },
  subject_documents: { authenticated: 'SI', service_role: '' },
  subject_milestones: { authenticated: '', service_role: '' },
  subject_notes: { authenticated: 'SI', service_role: '' },
  subject_status_history: { authenticated: 'SI', service_role: '' },
  subject_timeline: { authenticated: 'SI', service_role: 'I' },
  subjects: { authenticated: 'SIU', service_role: '' },
  task_comments: { authenticated: 'SI', service_role: '' },
  task_history: { authenticated: 'SI', service_role: 'I' },
  tasks: { authenticated: 'SIU', service_role: 'SIU' },
  user_invitations: { authenticated: 'S', service_role: 'SIU' },
  user_roles: { authenticated: 'SID', service_role: 'SI' },
  user_sites: { authenticated: 'SID', service_role: 'SI' },
  visit_history: { authenticated: 'I', service_role: '' },
  visit_notes: { authenticated: 'SI', service_role: '' },
  visit_template_items: { authenticated: 'SI', service_role: '' },
  visit_templates: { authenticated: 'SIU', service_role: '' },
  visits: { authenticated: 'SIU', service_role: 'SU' },
};

// Append-only records: never UPDATE or DELETE through the Data API.
const APPEND_ONLY = [
  'appointment_confirmation_log',
  'audit_logs',
  'chart_comments',
  'chart_history',
  'document_history',
  'lead_calls',
  'lead_contact_log',
  'lead_status_history',
  'migration_reconciliation_log',
  'subject_notes',
  'subject_status_history',
  'subject_timeline',
  'task_comments',
  'task_history',
  'visit_history',
  'visit_notes',
];

const LETTER: Record<string, string> = { SELECT: 'S', INSERT: 'I', UPDATE: 'U', DELETE: 'D' };
const ORDER = ['S', 'I', 'U', 'D'];

let sql: string;
let code: string; // SQL with comments stripped
let priorMigrations: string;
let tables: string[];

function grantsFor(role: string): Record<string, string> {
  const out: Record<string, Set<string>> = {};
  const re = /GRANT\s+([A-Z][A-Z,\s]*?)\s+ON\s+public\.([a-z_]+)\s+TO\s+([a-z_]+)\s*;/g;
  for (const m of code.matchAll(re)) {
    if (m[3] !== role) continue;
    const set = (out[m[2]!] ??= new Set());
    for (const p of m[1]!.split(',')) set.add(LETTER[p.trim()]!);
  }
  return Object.fromEntries(
    Object.entries(out).map(([t, s]) => [t, ORDER.filter((l) => s.has(l)).join('')]),
  );
}

beforeAll(() => {
  sql = readFileSync(resolve(MIGRATIONS_DIR, MIGRATION_FILE), 'utf8');
  code = sql.replace(/--[^\n]*/g, '');
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f) && f < MIGRATION_FILE)
    .sort();
  priorMigrations = files.map((f) => readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8')).join('\n');
  tables = [
    ...new Set(
      [
        ...priorMigrations.matchAll(
          /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:public\.)?([a-z_]+)\s*\(/gi,
        ),
      ]
        .map((m) => m[1]!.toLowerCase())
        .filter((t) => !['buckets', 'objects'].includes(t)),
    ),
  ].sort();
});

describe('migration 036 — file and version', () => {
  it('is the next free migration number', () => {
    const numbers = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .map((f) => f.slice(0, 3));
    expect(numbers.filter((n) => n === '036')).toHaveLength(1);
    expect(Math.max(...numbers.map(Number))).toBe(36);
  });

  it('runs in a single transaction', () => {
    expect(code).toMatch(/^\s*BEGIN;/m);
    expect(code).toMatch(/^\s*COMMIT;/m);
  });
});

describe('migration 036 — privilege matrix', () => {
  it('covers exactly the 66 public tables created by migrations 001–035', () => {
    expect(tables).toHaveLength(66);
    expect(Object.keys(EXPECTED).sort()).toEqual(tables);
  });

  it('grants authenticated exactly the reviewed matrix', () => {
    const got = grantsFor('authenticated');
    for (const t of tables)
      expect({ t, p: got[t] ?? '' }).toEqual({ t, p: EXPECTED[t]!.authenticated });
  });

  it('grants service_role exactly the reviewed matrix', () => {
    const got = grantsFor('service_role');
    for (const t of tables)
      expect({ t, p: got[t] ?? '' }).toEqual({ t, p: EXPECTED[t]!.service_role });
  });

  it('never grants anything to anon or PUBLIC', () => {
    expect(code).not.toMatch(/\bTO\s+(?:[a-z_]+\s*,\s*)*(anon|PUBLIC)\b/i);
    expect(code).not.toMatch(/\banon\b/i);
  });

  it('grants every UPDATE/DELETE together with SELECT (PostgREST filters read rows)', () => {
    for (const role of ['authenticated', 'service_role'] as const) {
      for (const [t, p] of Object.entries(grantsFor(role))) {
        if (/[UD]/.test(p))
          expect({ t, role, select: p.includes('S') }).toEqual({ t, role, select: true });
      }
    }
  });

  it('keeps append-only ledgers immutable (no UPDATE or DELETE for any role)', () => {
    for (const role of ['authenticated', 'service_role'] as const) {
      const got = grantsFor(role);
      for (const t of APPEND_ONLY)
        expect({ t, role, p: /[UD]/.test(got[t] ?? '') }).toEqual({ t, role, p: false });
    }
    for (const t of APPEND_ONLY) {
      expect(code).not.toMatch(
        new RegExp(`GRANT\\s+UPDATE\\s*\\([^)]*\\)\\s*ON\\s+public\\.${t}\\b`),
      );
    }
  });

  it('limits document_versions UPDATE to the four review-workflow columns', () => {
    const col = [
      ...code.matchAll(/GRANT\s+UPDATE\s*\(([^)]*)\)\s*ON\s+public\.([a-z_]+)\s+TO\s+([a-z_]+)/g),
    ];
    expect(col).toHaveLength(1);
    expect(col[0]![2]).toBe('document_versions');
    expect(col[0]![3]).toBe('authenticated');
    expect(
      col[0]![1]!
        .split(',')
        .map((c) => c.trim())
        .sort(),
    ).toEqual(['is_current', 'reviewed_at', 'reviewed_by', 'status']);
  });

  it('supports the post-login reads that failed in production (G7)', () => {
    expect(EXPECTED.profiles!.authenticated).toContain('S');
    expect(EXPECTED.companies!.authenticated).toContain('S');
    expect(EXPECTED.profiles!.authenticated).toContain('U'); // last_login_at
    expect(EXPECTED.audit_logs!.authenticated).toContain('I'); // auth.login / auth.logout
    for (const t of ['user_roles', 'roles', 'role_permissions', 'permissions']) {
      expect(EXPECTED[t]!.authenticated).toContain('S'); // PermissionService embed
    }
  });
});

describe('migration 036 — RLS alignment', () => {
  it('only exposes tables whose RLS is enabled by an earlier migration', () => {
    const rlsOn = new Set(
      [
        ...priorMigrations.matchAll(
          /ALTER TABLE\s+(?:public\.)?([a-z_]+)\s+ENABLE ROW LEVEL SECURITY/gi,
        ),
      ].map((m) => m[1]!.toLowerCase()),
    );
    for (const t of tables) expect({ t, rls: rlsOn.has(t) }).toEqual({ t, rls: true });
  });

  it('aborts if any public table has RLS disabled at apply time', () => {
    expect(code).toMatch(/NOT c\.relrowsecurity/);
    expect(code).toMatch(/RAISE EXCEPTION 'migration 036: RLS is disabled/);
  });

  it('grants authenticated only operations backed by an RLS policy (one documented upsert exception)', () => {
    const policies = new Set<string>();
    for (const m of priorMigrations.matchAll(
      /CREATE POLICY\s+"?[A-Za-z0-9_]+"?\s+ON\s+(?:public\.)?([a-z_]+)\s+(?:AS\s+\w+\s+)?FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)/gi,
    )) {
      const cmd = m[2]!.toUpperCase();
      for (const l of cmd === 'ALL' ? ORDER : [LETTER[cmd]!])
        policies.add(`${m[1]!.toLowerCase()}:${l}`);
    }
    const exceptions = new Set(['lead_duplicate_dismissals:U']); // ON CONFLICT DO UPDATE needs UPDATE at plan time
    for (const [t, p] of Object.entries(grantsFor('authenticated'))) {
      for (const l of p) {
        const key = `${t}:${l}`;
        expect({ key, backed: policies.has(key) || exceptions.has(key) }).toEqual({
          key,
          backed: true,
        });
      }
    }
    expect(policies.has('lead_duplicate_dismissals:U')).toBe(false);
    expect(policies.has('document_versions:U')).toBe(true);
  });
});

describe('migration 036 — scope guardrails', () => {
  it('is additive: no REVOKE and no ALTER DEFAULT PRIVILEGES', () => {
    expect(code).not.toMatch(/\bREVOKE\b/i);
    expect(code).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
  });

  it('touches only the public schema', () => {
    expect(code).not.toMatch(
      /\b(auth|storage|extensions|vault|cron|net|realtime|graphql)\.[a-z_]+/i,
    );
    expect(code).not.toMatch(/ALL\s+TABLES\s+IN\s+SCHEMA/i);
    expect(code).not.toMatch(/\bSEQUENCE\b/i);
  });

  it('creates no functions, policies or schema objects', () => {
    expect(code).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|POLICY|TABLE|VIEW|TRIGGER)/i);
    expect(code).not.toMatch(/\b(DROP|ALTER\s+TABLE|ALTER\s+POLICY|DISABLE\s+ROW)\b/i);
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE)\b/i);
  });

  it('never grants TRUNCATE, REFERENCES, TRIGGER or ALL', () => {
    expect(code).not.toMatch(/GRANT\s+(ALL|TRUNCATE|REFERENCES|TRIGGER|MAINTAIN)\b/i);
    expect(code).not.toMatch(/GRANT[^;]*\b(TRUNCATE|REFERENCES|TRIGGER|MAINTAIN)\b/i);
  });
});
