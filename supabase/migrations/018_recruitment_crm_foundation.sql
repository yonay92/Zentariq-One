-- Migration: 018_recruitment_crm_foundation.sql
-- Description: Sprint 7.1 — Recruitment CRM Foundation. Extends the existing
--   Sprint 5 lead pipeline (migration 014) with CRM operational fields
--   (priority, assignment, consent/do-not-contact, archiving), a richer
--   status vocabulary, additional PHI/demographic fields on the existing
--   contact-info split, and four new child tables: lead_notes, lead_calls,
--   lead_tasks, lead_status_history.
--
-- Design decisions (per product direction, see Sprint 7.1 plan):
--   1. Preserve the existing leads / lead_contact_info PHI split rather than
--      inlining PHI on a new table — `leads` stays the operational/pipeline
--      row, `lead_contact_info` stays the 1:1 PHI table. New child tables
--      follow the same `lead_*` naming convention as lead_contact_info /
--      lead_contact_log / lead_prescreenings (not `recruitment_lead_*`).
--   2. `status` is expanded to a superset — nothing existing is removed or
--      renamed. 'converted' remains the terminal successful status (set only
--      by LeadService.convertToSubject); there is no lead-level 'randomized'
--      status — actual randomization is a Subject/Visit-level clinical event
--      tracked elsewhere, out of scope for this phase (deferred, see Sprint
--      7.1 plan). 'archived' is not a status value — archiving is the new
--      orthogonal archived_at/archived_by soft-delete pair below, consistent
--      with how a lead can be archived from any non-terminal OR terminal
--      status without that being a "pipeline stage".
--   3. Source stays as the existing company-configurable referral_source_id
--      lookup (more flexible than a fixed enum); source_detail is added as
--      free-text supplementary detail alongside it.
--   4. New permissions are added only where the action is materially
--      different from what already exists (archive_lead, assign_lead,
--      view_lead_notes, create_lead_note, log_lead_call, manage_lead_tasks,
--      override_do_not_contact). view_recruitment_leads/create/edit/convert
--      from the original spec are intentionally NOT duplicated — they reuse
--      view_leads/create_lead/edit_lead/convert_lead.
--   5. normalized_phone/normalized_email on lead_contact_info support
--      duplicate detection (LeadDuplicateService) without altering the
--      preserved, user-entered display values.
--
-- Depends on: 014_recruitment_and_prescreening.sql (leads, lead_contact_info,
--   referral_sources), 002_roles_permissions.sql (permissions, has_permission,
--   can_access_site, current_company_id)
-- Rollback: see ROLLBACK section at the bottom

-- ============================================================
-- LEADS — new CRM operational columns + expanded status vocabulary
-- ============================================================

ALTER TABLE leads
  ADD COLUMN priority             text        NOT NULL DEFAULT 'medium',
  ADD COLUMN assigned_user_id     uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN consent_to_contact   boolean     NOT NULL DEFAULT false,
  ADD COLUMN do_not_contact       boolean     NOT NULL DEFAULT false,
  ADD COLUMN do_not_contact_reason text,
  ADD COLUMN source_detail        text,
  ADD COLUMN notes_summary        text,
  ADD COLUMN archived_at          timestamptz,
  ADD COLUMN archived_by          uuid        REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE leads
  ADD CONSTRAINT chk_leads_priority CHECK (
    priority IN ('low', 'medium', 'high', 'urgent')
  );

-- Superset of the original 7-value list — every existing value is preserved
-- so the current PrescreeningService/LeadService code paths (which still set
-- 'prescreening', 'waitlisted', 'converted', 'declined') keep working
-- unchanged. The new granular values are available to the new manual
-- status-change endpoint (LeadService.changeStatus) via an explicit
-- transition map enforced in the service layer, not the database. No
-- 'randomized' or 'archived' value — see header.
ALTER TABLE leads DROP CONSTRAINT chk_leads_status;
ALTER TABLE leads ADD CONSTRAINT chk_leads_status CHECK (
  status IN (
    'new', 'contact_attempted', 'contacted', 'voicemail_left', 'interested', 'not_interested',
    'prescreening', 'prescreen_scheduled', 'prescreen_in_progress', 'prescreen_complete',
    'qualified', 'not_qualified', 'screening_scheduled', 'screened', 'screen_failed',
    'withdrawn', 'waitlisted', 'converted', 'declined', 'lost'
  )
);

CREATE INDEX idx_leads_assigned_user ON leads(assigned_user_id);
-- Default "active" queries (business rule: archived leads never appear by
-- default) filter on archived_at IS NULL — a partial index keeps that cheap
-- regardless of how many leads accumulate archived history over time.
CREATE INDEX idx_leads_active ON leads(company_id) WHERE archived_at IS NULL;

-- ============================================================
-- LEAD_CONTACT_INFO — additional demographic/address fields +
-- normalized phone/email for duplicate detection. phone_secondary already
-- covers the spec's "secondary_phone" requirement — not duplicated.
-- ============================================================

ALTER TABLE lead_contact_info
  ADD COLUMN middle_name        text,
  ADD COLUMN preferred_name     text,
  ADD COLUMN gender_identity    text,
  ADD COLUMN preferred_language text,
  ADD COLUMN address_line_1     text,
  ADD COLUMN address_line_2     text,
  ADD COLUMN city               text,
  ADD COLUMN state              text,
  ADD COLUMN postal_code        text,
  ADD COLUMN country            text,
  ADD COLUMN normalized_phone   text,
  ADD COLUMN normalized_email   text;

CREATE INDEX idx_lead_contact_info_normalized_phone
  ON lead_contact_info(company_id, normalized_phone) WHERE normalized_phone IS NOT NULL;
CREATE INDEX idx_lead_contact_info_normalized_email
  ON lead_contact_info(company_id, normalized_email) WHERE normalized_email IS NOT NULL;
CREATE INDEX idx_lead_contact_info_name_dob
  ON lead_contact_info(company_id, last_name, first_name, date_of_birth);
CREATE INDEX idx_lead_contact_info_name_postal
  ON lead_contact_info(company_id, last_name, first_name, postal_code);

-- ============================================================
-- LEAD_NOTES  (FK -> companies, leads, profiles)
-- Freeform notes, distinct from the structured lead_contact_log. Editable by
-- their author only (enforced here via UPDATE USING, and in the service
-- layer). is_private restricts visibility to the author — a private note is
-- never visible to anyone else, even another user holding view_lead_notes.
-- ============================================================

CREATE TABLE lead_notes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  lead_id    uuid        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  note_type  text        NOT NULL DEFAULT 'general',
  body       text        NOT NULL,
  is_private boolean     NOT NULL DEFAULT false,
  created_by uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_lead_notes_type CHECK (
    note_type IN ('general', 'call_summary', 'eligibility', 'follow_up', 'other')
  )
);

CREATE INDEX idx_lead_notes_lead    ON lead_notes(lead_id);
CREATE INDEX idx_lead_notes_company ON lead_notes(company_id);

CREATE TRIGGER lead_notes_updated_at
  BEFORE UPDATE ON lead_notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE lead_notes ENABLE ROW LEVEL SECURITY;

-- SELECT allows either explicit permission — create_lead_note holders can
-- always read back their own inserts (required for INSERT ... RETURNING to
-- succeed under RLS), and view_lead_notes holders can read all non-private
-- notes plus their own private ones.
CREATE POLICY "lead_notes_select" ON lead_notes
  FOR SELECT USING (
    company_id = current_company_id()
    AND (has_permission('view_lead_notes') OR has_permission('create_lead_note'))
    AND (is_private = false OR created_by = auth.uid())
  );

CREATE POLICY "lead_notes_insert" ON lead_notes
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('create_lead_note')
  );

CREATE POLICY "lead_notes_update" ON lead_notes
  FOR UPDATE USING (
    company_id = current_company_id()
    AND has_permission('create_lead_note')
    AND created_by = auth.uid()
  )
  WITH CHECK (
    company_id = current_company_id()
    AND has_permission('create_lead_note')
    AND created_by = auth.uid()
  );

-- ============================================================
-- LEAD_CALLS  (FK -> companies, leads, profiles)
-- Structured call log — direction/outcome/duration — distinct from the
-- general-purpose lead_contact_log (which predates this and tracks pipeline
-- status transitions, not call mechanics). Append-only: no UPDATE policy.
-- ============================================================

CREATE TABLE lead_calls (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  lead_id             uuid        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  direction           text        NOT NULL,
  outcome             text        NOT NULL,
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,
  duration_seconds    integer,
  phone_number        text,
  summary             text,
  follow_up_required  boolean     NOT NULL DEFAULT false,
  follow_up_at        timestamptz,
  created_by          uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_lead_calls_direction CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT chk_lead_calls_outcome CHECK (
    outcome IN (
      'answered', 'no_answer', 'voicemail_left', 'busy', 'wrong_number', 'disconnected',
      'interested', 'not_interested', 'callback_requested', 'scheduled', 'other'
    )
  )
);

CREATE INDEX idx_lead_calls_lead    ON lead_calls(lead_id);
CREATE INDEX idx_lead_calls_company ON lead_calls(company_id);

ALTER TABLE lead_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lead_calls_select" ON lead_calls
  FOR SELECT USING (
    company_id = current_company_id()
    AND has_permission('log_lead_call')
  );

CREATE POLICY "lead_calls_insert" ON lead_calls
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('log_lead_call')
  );

-- ============================================================
-- LEAD_TASKS  (FK -> companies, sites, studies, leads, profiles)
-- Genuinely new — no Task Engine exists elsewhere in the codebase yet.
-- site_id/study_id are denormalized from the lead at creation time (nullable,
-- mirroring leads.site_id's company-wide-pool nullability) so task RLS can
-- enforce site scoping without a join back to leads on every check.
-- ============================================================

CREATE TABLE lead_tasks (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  site_id         uuid        REFERENCES sites(id) ON DELETE RESTRICT,
  study_id        uuid        REFERENCES studies(id) ON DELETE SET NULL,
  lead_id         uuid        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  title           text        NOT NULL,
  description     text,
  status          text        NOT NULL DEFAULT 'open',
  priority        text        NOT NULL DEFAULT 'medium',
  assigned_user_id uuid       REFERENCES profiles(id) ON DELETE SET NULL,
  due_at          timestamptz,
  completed_at    timestamptz,
  completed_by    uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  created_by      uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_lead_tasks_status CHECK (
    status IN ('open', 'in_progress', 'completed', 'cancelled')
  ),
  CONSTRAINT chk_lead_tasks_priority CHECK (
    priority IN ('low', 'medium', 'high', 'urgent')
  )
);

CREATE INDEX idx_lead_tasks_lead     ON lead_tasks(lead_id);
CREATE INDEX idx_lead_tasks_company  ON lead_tasks(company_id);
CREATE INDEX idx_lead_tasks_assigned ON lead_tasks(assigned_user_id);
CREATE INDEX idx_lead_tasks_site     ON lead_tasks(site_id);

CREATE TRIGGER lead_tasks_updated_at
  BEFORE UPDATE ON lead_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE lead_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lead_tasks_select" ON lead_tasks
  FOR SELECT USING (
    company_id = current_company_id()
    AND has_permission('manage_lead_tasks')
    AND (site_id IS NULL OR can_access_site(site_id))
  );

CREATE POLICY "lead_tasks_insert" ON lead_tasks
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('manage_lead_tasks')
    AND (site_id IS NULL OR can_access_site(site_id))
  );

CREATE POLICY "lead_tasks_update" ON lead_tasks
  FOR UPDATE USING (
    company_id = current_company_id()
    AND has_permission('manage_lead_tasks')
    AND (site_id IS NULL OR can_access_site(site_id))
  )
  WITH CHECK (
    company_id = current_company_id()
    AND has_permission('manage_lead_tasks')
    AND (site_id IS NULL OR can_access_site(site_id))
  );

-- ============================================================
-- LEAD_STATUS_HISTORY  (FK -> companies, leads, profiles)
-- Append-only. Written by every status-changing LeadService method
-- (logContact, waitlist, decline, changeStatus, convertToSubject) — closes
-- the gap where waitlist/decline/convertToSubject previously changed
-- leads.status without a corresponding history row (only lead_contact_log
-- captured logContact transitions). Gated by the same permissions that gate
-- the status-changing actions themselves (edit_lead, convert_lead) rather
-- than a new key — this table has no independent write path of its own.
-- ============================================================

CREATE TABLE lead_status_history (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  lead_id         uuid        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  previous_status text,
  new_status      text        NOT NULL,
  reason          text,
  changed_by      uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  changed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_status_history_lead    ON lead_status_history(lead_id);
CREATE INDEX idx_lead_status_history_company ON lead_status_history(company_id);

ALTER TABLE lead_status_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lead_status_history_select" ON lead_status_history
  FOR SELECT USING (
    company_id = current_company_id()
    AND has_permission('view_leads')
  );

CREATE POLICY "lead_status_history_insert" ON lead_status_history
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND (has_permission('edit_lead') OR has_permission('convert_lead'))
  );

-- ============================================================
-- LEADS — widen the existing UPDATE policy so archiving and assignment
-- (materially different actions, gated by their own new permissions) can
-- write to the same row via the same RLS policy; each action's specific
-- permission is enforced in the service layer (LeadService.archive requires
-- archive_lead, LeadService.assign requires assign_lead) — this is the same
-- OR-widening pattern already used by study_prescreening_questions'
-- edit_study/manage_studies policy.
-- ============================================================

DROP POLICY "leads_update" ON leads;
CREATE POLICY "leads_update" ON leads
  FOR UPDATE USING (
    company_id = current_company_id()
    AND (
      has_permission('edit_lead')
      OR has_permission('archive_lead')
      OR has_permission('assign_lead')
    )
    AND (site_id IS NULL OR can_access_site(site_id))
  )
  WITH CHECK (
    company_id = current_company_id()
    AND (
      has_permission('edit_lead')
      OR has_permission('archive_lead')
      OR has_permission('assign_lead')
    )
    AND (site_id IS NULL OR can_access_site(site_id))
  );

-- ============================================================
-- PERMISSIONS — new recruitment CRM keys. view_recruitment_leads/create/
-- edit/convert from the Sprint 7.1 spec are deliberately NOT added here —
-- they reuse the existing view_leads/create_lead/edit_lead/convert_lead keys
-- (see header).
-- ============================================================

INSERT INTO permissions (key, module, description)
VALUES
  ('archive_lead',            'recruitment', 'Archive a lead, removing it from default active views'),
  ('assign_lead',              'recruitment', 'Assign a lead to a specific user'),
  ('view_lead_notes',          'recruitment', 'View non-private notes recorded on a lead'),
  ('create_lead_note',         'recruitment', 'Add and edit your own notes on a lead'),
  ('log_lead_call',            'recruitment', 'Log and view phone call activity on a lead'),
  ('manage_lead_tasks',        'recruitment', 'Create, update, and complete follow-up tasks on a lead'),
  ('override_do_not_contact',  'recruitment', 'Create contact activity for a lead marked do-not-contact, with a required audited reason')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- ROLLBACK
-- DELETE FROM permissions WHERE key IN ('archive_lead', 'assign_lead', 'view_lead_notes', 'create_lead_note', 'log_lead_call', 'manage_lead_tasks', 'override_do_not_contact');
-- DROP POLICY IF EXISTS "leads_update" ON leads;
-- CREATE POLICY "leads_update" ON leads FOR UPDATE USING (company_id = current_company_id() AND has_permission('edit_lead') AND (site_id IS NULL OR can_access_site(site_id))) WITH CHECK (company_id = current_company_id() AND has_permission('edit_lead') AND (site_id IS NULL OR can_access_site(site_id)));
-- DROP POLICY IF EXISTS "lead_status_history_insert" ON lead_status_history;
-- DROP POLICY IF EXISTS "lead_status_history_select" ON lead_status_history;
-- DROP TABLE IF EXISTS lead_status_history CASCADE;
-- DROP POLICY IF EXISTS "lead_tasks_update" ON lead_tasks;
-- DROP POLICY IF EXISTS "lead_tasks_insert" ON lead_tasks;
-- DROP POLICY IF EXISTS "lead_tasks_select" ON lead_tasks;
-- DROP TABLE IF EXISTS lead_tasks CASCADE;
-- DROP POLICY IF EXISTS "lead_calls_insert" ON lead_calls;
-- DROP POLICY IF EXISTS "lead_calls_select" ON lead_calls;
-- DROP TABLE IF EXISTS lead_calls CASCADE;
-- DROP POLICY IF EXISTS "lead_notes_update" ON lead_notes;
-- DROP POLICY IF EXISTS "lead_notes_insert" ON lead_notes;
-- DROP POLICY IF EXISTS "lead_notes_select" ON lead_notes;
-- DROP TABLE IF EXISTS lead_notes CASCADE;
-- DROP INDEX IF EXISTS idx_lead_contact_info_name_postal;
-- DROP INDEX IF EXISTS idx_lead_contact_info_name_dob;
-- DROP INDEX IF EXISTS idx_lead_contact_info_normalized_email;
-- DROP INDEX IF EXISTS idx_lead_contact_info_normalized_phone;
-- ALTER TABLE lead_contact_info DROP COLUMN IF EXISTS normalized_email, DROP COLUMN IF EXISTS normalized_phone, DROP COLUMN IF EXISTS country, DROP COLUMN IF EXISTS postal_code, DROP COLUMN IF EXISTS state, DROP COLUMN IF EXISTS city, DROP COLUMN IF EXISTS address_line_2, DROP COLUMN IF EXISTS address_line_1, DROP COLUMN IF EXISTS preferred_language, DROP COLUMN IF EXISTS gender_identity, DROP COLUMN IF EXISTS preferred_name, DROP COLUMN IF EXISTS middle_name;
-- DROP INDEX IF EXISTS idx_leads_active;
-- DROP INDEX IF EXISTS idx_leads_assigned_user;
-- ALTER TABLE leads DROP CONSTRAINT chk_leads_status;
-- ALTER TABLE leads ADD CONSTRAINT chk_leads_status CHECK (status IN ('new', 'contacted', 'prescreening', 'waitlisted', 'converted', 'declined', 'lost'));
-- ALTER TABLE leads DROP CONSTRAINT chk_leads_priority;
-- ALTER TABLE leads DROP COLUMN IF EXISTS archived_by, DROP COLUMN IF EXISTS archived_at, DROP COLUMN IF EXISTS notes_summary, DROP COLUMN IF EXISTS source_detail, DROP COLUMN IF EXISTS do_not_contact_reason, DROP COLUMN IF EXISTS do_not_contact, DROP COLUMN IF EXISTS consent_to_contact, DROP COLUMN IF EXISTS assigned_user_id, DROP COLUMN IF EXISTS priority;
-- ============================================================
