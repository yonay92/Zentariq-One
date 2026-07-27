export type StudyStatus = 'draft' | 'active' | 'on_hold' | 'closed' | 'archived';

export type Study = {
  id: string;
  company_id: string;
  study_name: string;
  protocol_number: string | null;
  sponsor: string | null;
  cro: string | null;
  phase: string | null;
  therapeutic_area: string | null;
  indication: string | null;
  estimated_enrollment: number | null;
  study_duration: string | null;
  study_design: string | null;
  primary_endpoint: string | null;
  status: StudyStatus;
  start_date: string | null;
  end_date: string | null;
  protocol_version: string | null;
  ai_generated: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateStudyInput = {
  study_name: string;
  protocol_number?: string;
  protocol_version?: string;
  sponsor?: string;
  cro?: string;
  phase?: string;
  therapeutic_area?: string;
  indication?: string;
  estimated_enrollment?: number;
  study_duration?: string;
  study_design?: string;
  primary_endpoint?: string;
  start_date?: string;
  end_date?: string;
};

export type UpdateStudyInput = Partial<CreateStudyInput> & {
  status?: StudyStatus;
};

export type StudySiteStatus = 'active' | 'inactive';

export type StudySite = {
  id: string;
  company_id: string;
  study_id: string;
  site_id: string;
  status: StudySiteStatus;
  created_at: string;
};

export type StudyAssignedSite = {
  id: string;
  site_id: string;
  name: string;
  site_code: string | null;
  status: StudySiteStatus;
};

export type StudyStaffRole =
  'pi' | 'sub_i' | 'crc' | 'data_entry' | 'regulatory' | 'site_director' | 'other';

export type CrcOption = {
  user_id: string;
  full_name: string;
};

export type StudyStaff = {
  id: string;
  company_id: string;
  study_id: string;
  user_id: string;
  staff_role: StudyStaffRole;
  start_date: string | null;
  end_date: string | null;
  active: boolean;
  created_at: string;
};

export type VisitTemplateSource = 'manual' | 'ai_generated' | 'imported';
export type VisitTemplateStatus = 'draft' | 'approved' | 'archived';

export type VisitTemplate = {
  id: string;
  company_id: string;
  study_id: string;
  version: number;
  source: VisitTemplateSource;
  status: VisitTemplateStatus;
  approved_by: string | null;
  approved_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type VisitType = 'scheduled' | 'unscheduled';

export type VisitTemplateItem = {
  id: string;
  company_id: string;
  template_id: string;
  visit_name: string;
  visit_order: number;
  offset_days: number;
  window_before: number;
  window_after: number;
  visit_type: VisitType;
  is_required: boolean;
  is_baseline: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateVisitTemplateItemInput = {
  visit_name: string;
  visit_order: number;
  offset_days?: number | undefined;
  window_before?: number | undefined;
  window_after?: number | undefined;
  visit_type?: VisitType | undefined;
  is_required?: boolean | undefined;
  is_baseline?: boolean | undefined;
  notes?: string | undefined;
};

export type VisitTemplateWithItems = VisitTemplate & { items: VisitTemplateItem[] };

export type StudyDocumentType =
  | 'protocol'
  | 'icf'
  | 'investigator_brochure'
  | 'pharmacy_manual'
  | 'laboratory_manual'
  | 'schedule_of_assessments'
  | 'other';

export type StudyDocument = {
  id: string;
  company_id: string;
  study_id: string;
  file_id: string;
  document_type: StudyDocumentType;
  uploaded_by: string | null;
  ai_processed: boolean;
  created_at: string;
};

export type StudyAiExtractionType =
  | 'study_profile'
  | 'visit_template'
  | 'inclusion_criteria'
  | 'exclusion_criteria'
  | 'schedule_of_assessments'
  | 'protocol_amendment_comparison';

export type StudyAiExtraction = {
  id: string;
  company_id: string;
  study_id: string;
  extraction_type: StudyAiExtractionType;
  confidence: number | null;
  extracted_data: Record<string, unknown>;
  reviewed_by: string | null;
  reviewed_at: string | null;
  approved: boolean;
  created_at: string;
};

export type StudyDraftStatus = 'processing' | 'ready' | 'failed' | 'finalized';

export type StudyDraftProfile = {
  study_name?: string | null;
  protocol_number?: string | null;
  protocol_version?: string | null;
  sponsor?: string | null;
  cro?: string | null;
  phase?: string | null;
  therapeutic_area?: string | null;
  indication?: string | null;
  estimated_enrollment?: number | null;
  study_duration?: string | null;
  study_design?: string | null;
  primary_endpoint?: string | null;
  start_date?: string | null;
  end_date?: string | null;
};

export type StudyDraft = {
  id: string;
  company_id: string;
  file_id: string;
  status: StudyDraftStatus;
  confidence: number | null;
  uncertain_fields: string[];
  extracted_profile: StudyDraftProfile;
  extracted_visit_items: CreateVisitTemplateItemInput[];
  extracted_extra: Record<string, unknown>;
  error_message: string | null;
  study_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type FileRecord = {
  id: string;
  company_id: string;
  file_name: string;
  original_name: string | null;
  file_extension: string | null;
  mime_type: string | null;
  file_size: number | null;
  storage_path: string;
  uploaded_by: string | null;
  uploaded_at: string;
  checksum: string | null;
  ai_processed: boolean;
};

// Every key is computed from real backend state in
// StudyService.getActivationReadiness() — nothing here is hardcoded per
// study. `blocking: true` items mirror an actual enforced rule in
// StudyService.activateStudy() (today: an approved visit template, and the
// caller holding manage_studies) — everything else is a non-blocking,
// informational recommendation, since those aren't currently enforced
// business rules and this endpoint must not invent new ones unilaterally.
export type ActivationReadinessItemKey =
  | 'protocol_uploaded'
  | 'ai_extraction_completed'
  | 'ai_review_completed'
  | 'required_fields_completed'
  | 'sponsor_assigned'
  | 'protocol_number_assigned'
  | 'visit_templates_generated'
  | 'visit_templates_approved'
  | 'site_assigned'
  | 'regulatory_requirements_configured'
  | 'user_has_permission';

export type ActivationReadinessFixAction = {
  label: string;
  href: string | null;
};

export type ActivationReadinessItem = {
  key: ActivationReadinessItemKey;
  label: string;
  met: boolean;
  blocking: boolean;
  reason: string | null;
  fixAction: ActivationReadinessFixAction | null;
};

export type ActivationReadiness = {
  canActivate: boolean;
  blockingItems: ActivationReadinessItem[];
  warnings: ActivationReadinessItem[];
  items: ActivationReadinessItem[];
};
