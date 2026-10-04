/**
 * Migration 035 — structural regression tests.
 *
 * Same caveat as the migration-033 suite: these assert the migration's own
 * SQL text, not live Postgres behavior. Live behavioral proof (the two
 * closed bypasses, the reassignment-history trigger, the anon EXECUTE
 * matrix) lives in the Milestone 5 live security regression reports, not
 * here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_PATH = resolve(
  __dirname,
  '../../../supabase/migrations/035_task_engine_assignment_integrity_hardening.sql',
);

let sql: string;

beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf8');
});

describe('migration 035 — cross-company assignee (tasks_insert)', () => {
  it('requires the assignee to belong to the task company, in addition to site access', () => {
    const policyMatch = sql.match(/CREATE POLICY "tasks_insert"[\s\S]*?\);/);
    expect(policyMatch).not.toBeNull();
    const policy = policyMatch![0];
    expect(policy).toContain('user_has_site_access(assigned_to, site_id)');
    expect(policy).toMatch(
      /FROM profiles pr WHERE pr\.id = assigned_to AND pr\.company_id = company_id/,
    );
    // Role-queue tasks (assigned_to NULL) remain unaffected.
    expect(policy).toContain('assigned_to IS NULL');
  });
});

describe('migration 035 — cross-company assignee (enforce_task_update_invariants)', () => {
  it('requires the reassignment target to belong to the task company, in addition to site access', () => {
    expect(sql).toContain("has_permission('assign_task')");
    expect(sql).toMatch(/user_has_site_access\(NEW\.assigned_to,\s*NEW\.site_id\)/);
    expect(sql).toMatch(
      /FROM profiles pr WHERE pr\.id = NEW\.assigned_to AND pr\.company_id = NEW\.company_id/,
    );
    expect(sql).toContain("assignee does not belong to this task''s company");
  });

  it('allows the reassignment-only waiting -> assigned exception, guarded by an actual assignee change', () => {
    expect(sql).toMatch(
      /OLD\.status = 'waiting' AND NEW\.status = 'assigned'\s*\n\s*AND \(NEW\.assigned_to IS DISTINCT FROM OLD\.assigned_to OR NEW\.assigned_role IS DISTINCT FROM OLD\.assigned_role\)/,
    );
  });
});

describe('migration 035 — record_task_reassignment_history trigger', () => {
  it('creates an AFTER UPDATE trigger on tasks', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER trg_tasks_record_reassignment_history\s*\n\s*AFTER UPDATE ON tasks/,
    );
  });

  it('only fires on an actual assigned_to/assigned_role change', () => {
    const fnMatch = sql.match(
      /CREATE OR REPLACE FUNCTION record_task_reassignment_history[\s\S]*?\$\$;/,
    );
    expect(fnMatch).not.toBeNull();
    const fn = fnMatch![0];
    expect(fn).toMatch(/NEW\.assigned_to IS DISTINCT FROM OLD\.assigned_to/);
    expect(fn).toMatch(/NEW\.assigned_role IS DISTINCT FROM OLD\.assigned_role/);
    expect(fn).toContain('INSERT INTO task_history');
    expect(fn).toContain('auth.uid()');
    expect(fn).toContain("'Reassigned from '");
  });

  it('is an ordinary SECURITY INVOKER function (no elevated privilege) — its own INSERT stays subject to task_history_insert RLS', () => {
    const fnMatch = sql.match(
      /CREATE OR REPLACE FUNCTION record_task_reassignment_history[\s\S]*?\$\$;/,
    );
    expect(fnMatch![0]).not.toContain('SECURITY DEFINER');
  });
});

describe('migration 035 — task_history_insert reassignment exception', () => {
  it('accepts the waiting -> assigned reassignment shape without weakening the general transition check', () => {
    const policyMatch = sql.match(/CREATE POLICY "task_history_insert"[\s\S]*?\);/);
    expect(policyMatch).not.toBeNull();
    const policy = policyMatch![0];
    expect(policy).toContain(
      "task_history.old_status = 'waiting' AND task_history.new_status = 'assigned'",
    );
    // Still requires the real ledger-integrity checks from migration 033.
    expect(policy).toContain('changed_by = auth.uid()');
    expect(policy).toContain('t.status = task_history.new_status');
  });

  it('does not modify is_valid_task_transition itself (kept an exact mirror of TaskService.isValidTaskTransition)', () => {
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION is_valid_task_transition/);
  });
});

describe('migration 035 — anon EXECUTE hygiene', () => {
  it('revokes EXECUTE from anon on all three relevant functions', () => {
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION is_valid_task_transition(text, text) FROM anon',
    );
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION enforce_task_update_invariants() FROM anon');
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION record_task_reassignment_history() FROM anon',
    );
  });
});

describe('migration 035 — scope discipline', () => {
  it('preserves every migration-033 immutable-field check', () => {
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

  it('does not touch chart_assignments, chart_history, or chart_comments policies', () => {
    expect(sql).not.toMatch(/CREATE POLICY "chart_/);
  });

  it('does not modify tasks_select or task_comments_insert', () => {
    expect(sql).not.toMatch(/CREATE POLICY "tasks_select"/);
    expect(sql).not.toMatch(/CREATE POLICY "task_comments_insert"/);
  });

  it('includes the pre-apply invalid-data detection query in its own documentation', () => {
    expect(sql).toMatch(/p\.company_id IS DISTINCT FROM t\.company_id/);
  });

  it('includes a commented, reversible rollback block', () => {
    expect(sql).toContain('ROLLBACK (manual, if ever needed');
  });
});
