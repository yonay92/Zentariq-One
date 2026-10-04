/**
 * Migration 033 — structural regression tests.
 *
 * IMPORTANT — what these tests do and do not prove: vitest runs against
 * mocked Supabase clients, never a real Postgres instance, so there is no
 * way from this suite to actually attempt a direct anon-key + JWT mutation
 * and observe Postgres reject it (that requires a live database — see the
 * Milestone 5 Final E2E Validation report for why that was not available in
 * this environment). These tests instead assert, from the migration's own
 * SQL text, that the specific guardrails the security audit called for are
 * present and structurally correct (right columns, right auth.uid() ties,
 * right EXISTS joins). They are a regression net against someone silently
 * weakening or removing the migration later, not a substitute for a live
 * RLS/trigger integration test against a verified-safe environment.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_PATH = resolve(
  __dirname,
  '../../../supabase/migrations/033_task_engine_mutation_surface_hardening.sql',
);

let sql: string;

beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf8');
});

describe('migration 033 — tasks UPDATE invariant trigger', () => {
  it('creates a BEFORE UPDATE trigger on tasks', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER trg_tasks_enforce_update_invariants\s*\n\s*BEFORE UPDATE ON tasks/,
    );
  });

  it('pins every creation-time field as immutable on UPDATE', () => {
    for (const col of [
      'company_id',
      'site_id',
      'source_module',
      'source_record_type',
      'source_record_id',
      'created_by_system',
      'title',
      'description',
      'priority',
      'due_date',
      'created_at',
    ]) {
      expect(sql).toMatch(new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`));
    }
  });

  it('gates assigned_to/assigned_role changes on assign_task plus target site access', () => {
    expect(sql).toContain("has_permission('assign_task')");
    expect(sql).toMatch(/user_has_site_access\(NEW\.assigned_to,\s*NEW\.site_id\)/);
  });

  it('only allows status to move along the approved state machine (no self-loop, no terminal exit)', () => {
    expect(sql).toMatch(
      /OLD\.status = 'new'\s+AND NEW\.status IN \('assigned', 'in_progress', 'completed', 'cancelled'\)/,
    );
    expect(sql).toMatch(
      /OLD\.status = 'assigned'\s+AND NEW\.status IN \('in_progress', 'waiting', 'completed', 'cancelled'\)/,
    );
    expect(sql).toMatch(
      /OLD\.status = 'in_progress' AND NEW\.status IN \('waiting', 'completed', 'cancelled'\)/,
    );
    expect(sql).toMatch(
      /OLD\.status = 'waiting'\s+AND NEW\.status IN \('in_progress', 'completed', 'cancelled'\)/,
    );
    // completed/cancelled never appear as an OLD.status branch — no
    // outgoing edge exists for either, matching isValidTaskTransition.
    expect(sql).not.toMatch(/OLD\.status = 'completed'/);
    expect(sql).not.toMatch(/OLD\.status = 'cancelled'/);
  });
});

describe('migration 033 — tasks_insert (fake system-task / invalid-target prevention)', () => {
  it('pins manual-creation-only fields in WITH CHECK', () => {
    const policyMatch = sql.match(/CREATE POLICY "tasks_insert"[\s\S]*?\);/);
    expect(policyMatch).not.toBeNull();
    const policy = policyMatch![0];
    expect(policy).toContain('created_by_system = false');
    expect(policy).toContain("source_module = 'manual'");
    expect(policy).toContain('source_record_type IS NULL');
    expect(policy).toContain('source_record_id IS NULL');
    expect(policy).toMatch(/status IN \('new', 'assigned'\)/);
    expect(policy).toContain('user_has_site_access(assigned_to, site_id)');
    // create_task remains required — this hardens the policy, it doesn't
    // replace the permission gate.
    expect(policy).toContain("has_permission('create_task')");
  });
});

describe('migration 033 — task_history_insert (ledger spoofing prevention)', () => {
  it('requires changed_by to match the calling session', () => {
    const policyMatch = sql.match(/CREATE POLICY "task_history_insert"[\s\S]*?\);/);
    expect(policyMatch).not.toBeNull();
    expect(policyMatch![0]).toContain('changed_by = auth.uid()');
  });

  it("ties new_status to the task's real current status and validates the claimed transition", () => {
    const policyMatch = sql.match(/CREATE POLICY "task_history_insert"[\s\S]*?\);/);
    const policy = policyMatch![0];
    expect(policy).toContain('t.status = task_history.new_status');
    expect(policy).toContain(
      'is_valid_task_transition(task_history.old_status, task_history.new_status)',
    );
    // The initial "task created" row (old_status IS NULL) and reassignment's
    // same-status row remain legal.
    expect(policy).toContain('task_history.old_status IS NULL');
    expect(policy).toContain('task_history.old_status = task_history.new_status');
  });

  it('defines is_valid_task_transition matching TaskService.isValidTaskTransition exactly', () => {
    expect(sql).toMatch(
      /WHEN 'new'\s+THEN p_new IN \('assigned', 'in_progress', 'completed', 'cancelled'\)/,
    );
    expect(sql).toMatch(
      /WHEN 'assigned'\s+THEN p_new IN \('in_progress', 'waiting', 'completed', 'cancelled'\)/,
    );
    expect(sql).toMatch(/WHEN 'in_progress' THEN p_new IN \('waiting', 'completed', 'cancelled'\)/);
    expect(sql).toMatch(
      /WHEN 'waiting'\s+THEN p_new IN \('in_progress', 'completed', 'cancelled'\)/,
    );
  });
});

describe('migration 033 — task_comments_insert (author spoofing prevention)', () => {
  it('requires created_by to match the calling session', () => {
    const policyMatch = sql.match(/CREATE POLICY "task_comments_insert"[\s\S]*?\);/);
    expect(policyMatch).not.toBeNull();
    expect(policyMatch![0]).toContain('created_by = auth.uid()');
  });
});

describe('migration 033 — M4 debt: chart_history / chart_comments site isolation', () => {
  it('chart_history_select requires can_access_site on the parent chart', () => {
    const policyMatch = sql.match(/CREATE POLICY "chart_history_select"[\s\S]*?\);/);
    expect(policyMatch).not.toBeNull();
    const policy = policyMatch![0];
    expect(policy).toContain("has_permission('view_charts')");
    expect(policy).toMatch(
      /FROM charts c WHERE c\.id = chart_history\.chart_id AND can_access_site\(c\.site_id\)/,
    );
  });

  it('chart_comments_select requires can_access_site on the parent chart', () => {
    const policyMatch = sql.match(/CREATE POLICY "chart_comments_select"[\s\S]*?\);/);
    expect(policyMatch).not.toBeNull();
    const policy = policyMatch![0];
    expect(policy).toContain("has_permission('view_charts')");
    expect(policy).toMatch(
      /FROM charts c WHERE c\.id = chart_comments\.chart_id AND can_access_site\(c\.site_id\)/,
    );
  });
});

describe('migration 033 — scope discipline', () => {
  it('does not touch chart_assignments (re-audited, no server-side sync semantics exist to bypass)', () => {
    expect(sql).not.toMatch(/CREATE POLICY "chart_assignments_/);
    expect(sql).not.toMatch(/ALTER TABLE chart_assignments/);
  });

  it('does not modify the Task state machine or add a new API-visible object beyond the two documented functions', () => {
    expect(sql).not.toMatch(/CREATE POLICY "tasks_select"/);
    expect(sql).not.toMatch(/CREATE POLICY "tasks_update"/); // UPDATE stays RLS-gated as before; the trigger adds invariants, not a new policy
  });

  it('includes a commented, reversible rollback block', () => {
    expect(sql).toContain('ROLLBACK (manual, if ever needed');
  });
});
