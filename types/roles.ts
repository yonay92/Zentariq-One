export type Role = {
  id: string;
  company_id: string;
  name: string;
  key: string;
  description: string | null;
  is_system_role: boolean;
  created_at: string;
  updated_at: string;
};

export type UserRole = {
  id: string;
  company_id: string;
  user_id: string;
  role_id: string;
  created_at: string;
};

export type Permission = {
  id: string;
  key: string;
  module: string;
  description: string | null;
  created_at: string;
};

export type RolePermission = {
  id: string;
  company_id: string;
  role_id: string;
  permission_id: string;
  allowed: boolean;
  created_at: string;
};

export type SystemRoleKey = 'admin' | 'ceo' | 'crc' | 'data_entry' | 'regulatory' | 'pi';

export type PermissionKey =
  | 'view_dashboard'
  | 'create_study'
  | 'edit_study'
  | 'view_studies'
  | 'manage_studies'
  | 'create_subject'
  | 'edit_subject'
  | 'view_subjects'
  | 'view_visits'
  | 'manage_visits'
  | 'view_charts'
  | 'mark_chart_ready'
  | 'mark_chart_entered'
  | 'reopen_chart'
  | 'comment_chart'
  | 'view_regulatory'
  | 'upload_regulatory_document'
  | 'edit_regulatory_document'
  | 'archive_regulatory_document'
  | 'view_documents'
  | 'upload_documents'
  | 'edit_business_rules'
  | 'view_all_sites'
  | 'manage_users'
  | 'view_audit_logs'
  | 'manage_sites'
  | 'manage_settings'
  | 'view_analytics'
  | 'force_archive_study'
  | 'force_archive_site'
  | 'reopen_visit'
  | 'view_subject_phi'
  | 'edit_subject_phi'
  | 'view_leads'
  | 'create_lead'
  | 'edit_lead'
  | 'view_lead_phi'
  | 'edit_lead_phi'
  | 'convert_lead'
  | 'manage_referral_sources'
  | 'archive_lead'
  | 'assign_lead'
  | 'view_lead_notes'
  | 'create_lead_note'
  | 'log_lead_call'
  | 'manage_lead_tasks'
  | 'override_do_not_contact'
  | 'bulk_manage_recruitment_leads'
  | 'dismiss_recruitment_duplicates'
  | 'reopen_recruitment_tasks'
  | 'view_recruitment_dashboard'
  | 'manage_regulatory_requirements'
  | 'view_staff_credentials'
  | 'manage_staff_credentials'
  | 'view_regulatory_audit'
  | 'override_regulatory_status';
