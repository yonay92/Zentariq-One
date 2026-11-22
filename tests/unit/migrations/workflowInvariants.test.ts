/**
 * Migration 039 — workflow invariants: parity with the TypeScript services and
 * structural security pins.
 *
 * vitest never talks to Postgres: these assertions read the migration's SQL
 * text. They guarantee that the database transition table and the service
 * maps cannot drift apart silently (rule drift, M4 §8), and pin the security
 * properties of the `private` schema and the new permission. The behaviour
 * itself is proven against an isolated local database by the E2 suite
 * (transition/permission matrices, sequence, exceptions, concurrency, REST).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isValidStatusTransition } from '@/services/subjects/SubjectService';
import { isValidChartTransition } from '@/services/charts/ChartService';
import { STATUS_TRANSITIONS, TERMINAL_STATUSES } from '@/services/recruitment/LeadService';
import type { SubjectStatus } from '@/types/subjects';
import type { ChartStatus } from '@/types/charts';

const ROOT = resolve(__dirname, '../../..');
const SQL = readFileSync(resolve(ROOT, 'supabase/migrations/039_workflow_invariants.sql'), 'utf8');

type Row = { entity: string; from: string; to: string; permission: string; enforcement: string };
const ROWS: Row[] = [
  ...SQL.matchAll(/\('(\w+)',\s*'(\w+)',\s*'(\w+)',\s*'(\w+)',\s*'(enforced|reference)'/g),
].map((m) => ({
  entity: m[1] as string,
  from: m[2] as string,
  to: m[3] as string,
  permission: m[4] as string,
  enforcement: m[5] as string,
}));
const pairs = (entity: string, enforcement = 'enforced') =>
  ROWS.filter((r) => r.entity === entity && r.enforcement === enforcement)
    .map((r) => `${r.from}->${r.to}`)
    .sort();

const SUBJECT_STATUSES: SubjectStatus[] = [
  'pre_screening',
  'screening',
  'randomized',
  'active',
  'completed',
  'screen_failed',
  'early_terminated',
  'lost_to_follow_up',
];
const CHART_STATUSES: ChartStatus[] = ['chart_ready', 'in_progress', 'entered_in_edc', 'on_hold'];

describe('039 transition table — parity with the services', () => {
  it('parses the expected number of rows (29 enforced, 41 reference)', () => {
    expect(ROWS.filter((r) => r.enforcement === 'enforced')).toHaveLength(29);
    expect(ROWS.filter((r) => r.enforcement === 'reference')).toHaveLength(41);
    expect(SQL).toContain("WHERE enforcement = 'enforced') <> 29");
    expect(SQL).toContain("WHERE enforcement = 'reference') <> 41");
  });

  it('subjects: exactly the pairs SubjectService.isValidStatusTransition accepts', () => {
    const expected = SUBJECT_STATUSES.flatMap((f) =>
      SUBJECT_STATUSES.filter((t) => isValidStatusTransition(f, t)).map((t) => `${f}->${t}`),
    ).sort();
    expect(pairs('subjects')).toEqual(expected);
  });

  it('charts: the generic chart map plus the dedicated reopen path (ChartService.reopenChart)', () => {
    const expected = [
      ...CHART_STATUSES.flatMap((f) =>
        CHART_STATUSES.filter((t) => isValidChartTransition(f, t)).map((t) => `${f}->${t}`),
      ),
      'entered_in_edc->in_progress',
    ].sort();
    expect(pairs('charts')).toEqual(expected);
  });

  it('leads: reference rows equal LeadService.STATUS_TRANSITIONS', () => {
    const expected = Object.entries(STATUS_TRANSITIONS)
      .flatMap(([f, ts]) => (ts ?? []).map((t) => `${f}->${t}`))
      .sort();
    expect(pairs('leads', 'reference')).toEqual(expected);
    expect(pairs('leads')).toEqual([]);
  });

  it('leads: the database does not restrict exits from closed statuses (Obs-3 parity with changeStatus)', () => {
    // LeadService.changeStatus does not apply assertNotTerminal; the trigger
    // must not be stricter than the application until the owner decides Obs-3.
    const fn =
      SQL.match(/CREATE FUNCTION public\.enforce_leads_workflow\(\)[\s\S]*?\n\$\$;/)?.[0] ?? '';
    expect(fn).not.toBe('');
    for (const s of TERMINAL_STATUSES.filter((x) => x !== 'converted')) {
      expect(fn).not.toContain(`'${s}'`);
    }
    expect(fn).toContain(
      "'leads: converted is set only by Convert to Subject, together with the subject'",
    );
    expect(fn).toContain("'leads: the converted subject cannot be changed'");
  });

  it('visits: the VisitService/SubjectService paths (confirm, start, complete, cancel, reopen)', () => {
    // VisitService.confirmVisit/startVisit/cancelVisit/reopenVisit and
    // SubjectService.completeVisit/completeBaselineVisit (via complete_visit_with_chart).
    expect(pairs('visits')).toEqual(
      [
        'scheduled->confirmed',
        'confirmed->in_progress',
        'in_progress->completed',
        'in_progress->out_of_window',
        'scheduled->cancelled',
        'confirmed->cancelled',
        'in_progress->cancelled',
        'completed->in_progress',
      ].sort(),
    );
    const perm = (f: string, t: string) =>
      ROWS.find((r) => r.entity === 'visits' && r.from === f && r.to === t)?.permission;
    expect(perm('completed', 'in_progress')).toBe('reopen_visit');
    expect(perm('in_progress', 'completed')).toBe('edit_subject');
    expect(perm('scheduled', 'cancelled')).toBe('manage_visits');
  });

  it('visit templates: approve, archive (VisitTemplateService.approveTemplate/archiveTemplate)', () => {
    expect(pairs('visit_templates')).toEqual(
      ['draft->approved', 'approved->archived', 'draft->archived'].sort(),
    );
    expect(
      ROWS.filter((r) => r.entity === 'visit_templates').every(
        (r) => r.permission === 'manage_studies',
      ),
    ).toBe(true);
  });
});

describe('039 security pins', () => {
  it('schema private: no PUBLIC/anon access, USAGE only for authenticated', () => {
    expect(SQL).toContain('REVOKE ALL ON SCHEMA private FROM PUBLIC;');
    expect(SQL).toContain('GRANT USAGE ON SCHEMA private TO authenticated;');
    expect(SQL).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\banon\b/i);
    expect(SQL).toContain(
      'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(SQL).toContain('REVOKE ALL ON private.workflow_transitions FROM PUBLIC;');
  });

  it('every SECURITY DEFINER function pins its search_path', () => {
    const definers = [
      ...SQL.matchAll(/CREATE FUNCTION ([\w.]+)\([^)]*\)([\s\S]*?)AS \$\$/g),
    ].filter((m) => /SECURITY DEFINER/.test(m[2] as string));
    expect(definers.length).toBeGreaterThanOrEqual(9);
    for (const d of definers) expect(d[2]).toMatch(/SET search_path = (public|private), pg_temp/);
  });

  it('workflow triggers act only for Data API roles (service_role and migrations pass through)', () => {
    const triggerFns = [...SQL.matchAll(/CREATE FUNCTION public\.enforce_(\w+)_workflow\(\)/g)];
    expect(triggerFns).toHaveLength(7);
    const guards = SQL.match(/IF current_user NOT IN \('authenticated', 'anon'\) THEN/g) ?? [];
    expect(guards.length).toBe(7);
  });

  it('override_visit_sequence is created but granted to no role', () => {
    expect(SQL).toContain("VALUES ('override_visit_sequence', 'visits',");
    expect(SQL).not.toMatch(/INSERT INTO public\.role_permissions/i);
    expect(SQL).toContain(
      "WHERE p.key = 'override_visit_sequence') THEN\n    v_bad := v_bad || ' default-grant'",
    );
  });

  it('the Administrator default-grant exclusions list override_visit_sequence in both places', () => {
    const companyService = readFileSync(
      resolve(ROOT, 'services/company/CompanyService.ts'),
      'utf8',
    );
    const bootstrap = readFileSync(resolve(ROOT, 'supabase/bootstrap_admin.sql'), 'utf8');
    const tsList =
      companyService.match(/ADMIN_EXCLUDED_PERMISSIONS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
    const sqlList =
      bootstrap.match(/c_admin_excluded constant text\[\] := ARRAY\[([\s\S]*?)\];/)?.[1] ?? '';
    const keys = (s: string) => (s.match(/'(\w+)'/g) ?? []).map((k) => k.slice(1, -1)).sort();
    expect(keys(tsList)).toContain('override_visit_sequence');
    expect(keys(tsList)).toEqual(keys(sqlList));
  });

  it('sequence exceptions: no UPDATE/DELETE grant, one open exception per visit, reason bounds', () => {
    expect(SQL).toContain(
      'GRANT SELECT, INSERT ON public.visit_sequence_exceptions TO authenticated, service_role;',
    );
    expect(SQL).toContain(
      'CREATE UNIQUE INDEX uq_visit_sequence_exceptions_open ON public.visit_sequence_exceptions (visit_id) WHERE consumed_at IS NULL;',
    );
    expect(SQL).toContain('CHECK (length(btrim(reason)) BETWEEN 10 AND 2000)');
    expect(SQL).toContain("enforce_row_attribution('creator:authorized_by:authorized_at')");
  });

  it('the exception gate consumes under a row lock and refuses calls outside a trigger', () => {
    expect(SQL).toMatch(
      /UPDATE visit_sequence_exceptions e\s+SET consumed_at = now\(\), consumed_status = p_new_status\s+WHERE e\.visit_id = p_visit AND e\.company_id = p_company AND e\.consumed_at IS NULL/,
    );
    expect(SQL).toContain(
      'IF pg_trigger_depth() < 1 OR p_company IS DISTINCT FROM current_company_id() THEN',
    );
  });

  // Final review H-1 (2026-11-21): the sequence and O-1 cannot be bypassed by
  // re-pointing visits, fabricating predecessors or editing dates.
  it('H-1: one visit per subject and template visit, cancelled ones included', () => {
    expect(SQL).toMatch(
      /CREATE UNIQUE INDEX uq_visits_subject_template_item\s+ON public\.visits \(subject_id, visit_template_item_id\)\s+WHERE visit_template_item_id IS NOT NULL;/,
    );
    expect(SQL).toContain("' unique-visit-index'");
  });

  it('H-1: every Data API visit INSERT and UPDATE goes through visit_write_blocker', () => {
    expect(SQL).toContain("v_block := private.visit_write_blocker('INSERT', NULL, NEW);");
    expect(SQL).toContain("v_block := private.visit_write_blocker('UPDATE', OLD, NEW);");
    expect(SQL).toMatch(
      /p_new\.subject_id IS DISTINCT FROM p_old\.subject_id\s+OR p_new\.study_id IS DISTINCT FROM p_old\.study_id OR p_new\.site_id IS DISTINCT FROM p_old\.site_id\s+OR p_new\.visit_template_item_id IS DISTINCT FROM p_old\.visit_template_item_id/,
    );
    expect(SQL).toContain("v_t_status = 'approved'");
    expect(SQL).toContain('OR p_new.window_start < p_new.target_date - coalesce(v_before, 0)');
    expect(SQL).toContain('OR p_new.window_end > p_new.target_date + coalesce(v_after, 0)');
  });

  it("H-1: the subject's baseline date must match its completed baseline visit", () => {
    expect(SQL).toContain(
      'AND NOT private.subject_baseline_matches(NEW.id, NEW.company_id, NEW.baseline_date) THEN',
    );
    expect(SQL).toContain(
      "RAISE EXCEPTION 'subjects: the baseline date is recorded when the baseline visit is completed'",
    );
  });

  // Final review M-1: BEFORE triggers run before the RLS WITH CHECK of an
  // INSERT, so the INSERT policy is applied first and answered like RLS.
  it('M-1: INSERT checks that read other rows first answer exactly like RLS', () => {
    for (const table of [
      'subjects',
      'visits',
      'charts',
      'visit_template_items',
      'visit_sequence_exceptions',
    ]) {
      expect(SQL).toContain(
        `RAISE EXCEPTION 'new row violates row-level security policy for table "${table}"' USING ERRCODE = '42501';`,
      );
    }
  });

  it('M-1: the exception authorization trigger runs first; the definer lookup is scoped to the site and subject', () => {
    expect(SQL).toContain(
      'CREATE TRIGGER trg_visit_sequence_exceptions_authorize BEFORE INSERT ON public.visit_sequence_exceptions',
    );
    expect(SQL).toContain("' trigger-order'");
    expect(SQL).toMatch(
      /WHERE id = NEW\.visit_id AND company_id = NEW\.company_id AND site_id = NEW\.site_id AND subject_id = NEW\.subject_id\s+FOR UPDATE;/,
    );
    expect(SQL).toContain('private.visit_is_done(NEW.visit_id, NEW.company_id, NEW.site_id)');
  });
});
