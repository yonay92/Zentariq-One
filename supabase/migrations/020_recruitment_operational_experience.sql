-- Migration: 020_recruitment_operational_experience.sql
-- Description: Sprint 7.2 — Recruitment CRM Operational Experience. Adds the
--   schema support needed for the enterprise Lead Table, Kanban Pipeline,
--   duplicate review workflow, and follow-up/task queues built on top of the
--   Sprint 7.1 foundation (migrations 014/018/019). No new Lead entity, no
--   parallel tables — purely additive.
--
-- Design decisions:
--   1. lead_duplicate_dismissals is new — Sprint 7.1's checkDuplicates was
--      stateless (nothing persisted a "not a duplicate" decision). A
--      dismissal is recorded per (lead_id, matched_lead_id) pair with a
--      mandatory reason; checkDuplicates (extended in this sprint) excludes
--      dismissed pairs from blocking but the dismissal itself remains
--      visible/audited — never a silent suppression.
--   2. No new "scheduling" columns (e.g. prescreen_scheduled_at) — the
--      dashboard's "scheduled today" metrics reuse the existing
--      leads.next_contact_at column (product decision, Sprint 7.2 plan) to
--      avoid an unnecessary schema addition for a field that already exists
--      under a different name.
--   3. Indexes added only for columns this sprint's new queries actually
--      filter/sort on and that migration 018 didn't already cover:
--      leads.priority, leads(company_id, created_at) for pagination default
--      sort, and lead_tasks(status, due_at) / lead_tasks(assigned_user_id,
--      status) for follow-up/task queues. company_id, site_id, study_id,
--      status, assigned_user_id, archived_at already have coverage from
--      migrations 014/018.
--
-- Depends on: 018_recruitment_crm_foundation.sql (leads, lead_tasks)
-- Rollback: see ROLLBACK section at the bottom

-- ============================================================
-- LEAD_DUPLICATE_DISMISSALS  (FK -> companies, leads x2, profiles)
-- Directional storage (lead_id, matched_lead_id) — the dismissal-exclusion
-- query in LeadDuplicateService checks both directions, since a match
-- reviewed from either lead's side should suppress the pair for both.
-- ============================================================

CREATE TABLE lead_duplicate_dismissals (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  lead_id          uuid        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  matched_lead_id  uuid        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  reason           text        NOT NULL,
  dismissed_by     uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  dismissed_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_lead_duplicate_dismissals_distinct CHECK (lead_id <> matched_lead_id),
  CONSTRAINT uq_lead_duplicate_dismissals UNIQUE (company_id, lead_id, matched_lead_id)
);

CREATE INDEX idx_lead_duplicate_dismissals_lead
  ON lead_duplicate_dismissals(lead_id);
CREATE INDEX idx_lead_duplicate_dismissals_matched
  ON lead_duplicate_dismissals(matched_lead_id);
CREATE INDEX idx_lead_duplicate_dismissals_company
  ON lead_duplicate_dismissals(company_id);

ALTER TABLE lead_duplicate_dismissals ENABLE ROW LEVEL SECURITY;

-- Same read gate as duplicate checking itself (view_lead_phi) — a dismissal
-- record only makes sense to someone who could see the underlying match.
CREATE POLICY "lead_duplicate_dismissals_select" ON lead_duplicate_dismissals
  FOR SELECT USING (
    company_id = current_company_id()
    AND has_permission('view_lead_phi')
  );

CREATE POLICY "lead_duplicate_dismissals_insert" ON lead_duplicate_dismissals
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('dismiss_recruitment_duplicates')
  );

-- ============================================================
-- NEW INDEXES — leads (priority, pagination default sort)
-- ============================================================

CREATE INDEX idx_leads_priority ON leads(company_id, priority);
CREATE INDEX idx_leads_company_created ON leads(company_id, created_at DESC);

-- ============================================================
-- NEW INDEXES — lead_tasks (follow-up / "My Follow-ups" queues)
-- ============================================================

CREATE INDEX idx_lead_tasks_status_due ON lead_tasks(company_id, status, due_at);
CREATE INDEX idx_lead_tasks_assigned_status ON lead_tasks(assigned_user_id, status);

-- ============================================================
-- PERMISSIONS — recruitment operational-experience module
-- ============================================================

INSERT INTO permissions (key, module, description)
VALUES
  ('bulk_manage_recruitment_leads', 'recruitment', 'Apply bulk assign/priority/task/archive/status actions to multiple leads at once'),
  ('dismiss_recruitment_duplicates', 'recruitment', 'Dismiss a possible duplicate lead match as not a duplicate, with a required reason'),
  ('reopen_recruitment_tasks',       'recruitment', 'Reopen a completed or cancelled lead task, with a required audited reason'),
  ('view_recruitment_dashboard',     'recruitment', 'View the recruitment operational dashboard and its metrics')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- ROLLBACK
-- DELETE FROM permissions WHERE key IN ('bulk_manage_recruitment_leads', 'dismiss_recruitment_duplicates', 'reopen_recruitment_tasks', 'view_recruitment_dashboard');
-- DROP INDEX IF EXISTS idx_lead_tasks_assigned_status;
-- DROP INDEX IF EXISTS idx_lead_tasks_status_due;
-- DROP INDEX IF EXISTS idx_leads_company_created;
-- DROP INDEX IF EXISTS idx_leads_priority;
-- DROP POLICY IF EXISTS "lead_duplicate_dismissals_insert" ON lead_duplicate_dismissals;
-- DROP POLICY IF EXISTS "lead_duplicate_dismissals_select" ON lead_duplicate_dismissals;
-- DROP TABLE IF EXISTS lead_duplicate_dismissals CASCADE;
-- ============================================================
