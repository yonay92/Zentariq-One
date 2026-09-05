-- Seed: 002_permissions.sql
-- Description: Global permissions catalog. Inserted once at database initialization.
-- These are company-independent — all companies share the same permission keys.

INSERT INTO permissions (key, module, description) VALUES
  -- Dashboard
  ('view_dashboard',              'dashboard',     'View the main dashboard'),

  -- Studies
  ('create_study',                'studies',       'Create new studies'),
  ('edit_study',                  'studies',       'Edit existing studies'),
  ('view_studies',                'studies',       'View studies and study details'),
  ('manage_studies',              'studies',       'Full study management including activation and closure'),

  -- Subjects
  ('view_subjects',               'subjects',      'View subjects and subject profiles'),
  ('create_subject',              'subjects',      'Create new subjects'),
  ('edit_subject',                'subjects',      'Edit subject information and status'),

  -- Visits
  ('view_visits',                 'visits',        'View visits and visit details'),
  ('manage_visits',               'visits',        'Schedule, complete, and cancel visits'),

  -- Charts
  ('view_charts',                 'charts',        'View the chart data entry queue'),
  ('mark_chart_ready',            'charts',        'Manage a chart through the pre-entry pipeline (start entry, hold, release)'),
  ('mark_chart_entered',          'charts',        'Mark a chart as entered in EDC'),
  ('reopen_chart',                'charts',        'Reopen an Entered-in-EDC chart for authorized correction'),

  -- Regulatory
  ('view_regulatory',             'regulatory',    'View regulatory documents and binders'),
  ('upload_regulatory_document',  'regulatory',    'Upload regulatory documents'),
  ('edit_regulatory_document',    'regulatory',    'Edit regulatory document metadata'),
  ('archive_regulatory_document', 'regulatory',    'Archive regulatory documents'),

  -- Documents
  ('view_documents',              'documents',     'View enterprise document center'),
  ('upload_documents',            'documents',     'Upload documents'),

  -- Tasks
  ('view_tasks',                  'tasks',         'View the task center'),
  ('complete_task',               'tasks',         'Complete assigned tasks'),
  ('assign_task',                 'tasks',         'Assign tasks to other users'),

  -- Business Rules
  ('edit_business_rules',         'business_rules', 'Create and modify business rules'),
  ('view_business_rules',         'business_rules', 'View business rules and execution logs'),

  -- Analytics
  ('view_analytics',              'analytics',     'View analytics dashboards and reports'),

  -- Settings & Admin
  ('manage_settings',             'settings',      'Modify company settings and configuration'),
  ('manage_sites',                'settings',      'Create and manage clinical sites'),
  ('manage_users',                'settings',      'Invite, edit, and deactivate users'),
  ('view_all_sites',              'settings',      'Access records from all sites without site restriction'),
  ('view_audit_logs',             'settings',      'View the immutable audit trail');

ON CONFLICT (key) DO NOTHING;
