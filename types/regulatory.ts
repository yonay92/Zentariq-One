import type { FileRecord } from '@/types/studies';

export type DocumentTypeCategory = string;

export type DocumentType = {
  id: string;
  company_id: string;
  name: string;
  category: DocumentTypeCategory | null;
  has_expiration: boolean;
  expiration_rule: Record<string, unknown> | null;
  default_alert_days: number[];
  requires_version: boolean;
  required_by_default: boolean;
  created_at: string;
  updated_at: string;
};

export type CreateDocumentTypeInput = {
  name: string;
  category?: string | undefined;
  has_expiration?: boolean | undefined;
  default_alert_days?: number[] | undefined;
  requires_version?: boolean | undefined;
  required_by_default?: boolean | undefined;
};

export type UpdateDocumentTypeInput = {
  name?: string | undefined;
  category?: string | undefined;
  has_expiration?: boolean | undefined;
  default_alert_days?: number[] | undefined;
  requires_version?: boolean | undefined;
  required_by_default?: boolean | undefined;
};

export type RegulatoryRequirementScope = 'company' | 'site' | 'study';

export type RegulatoryDocumentRequirement = {
  id: string;
  company_id: string;
  study_id: string | null;
  site_id: string | null;
  document_type_id: string;
  required: boolean;
  expiration_required: boolean;
  applies_to: string | null;
  created_at: string;
};

export type CreateRegulatoryRequirementInput = {
  document_type_id: string;
  study_id?: string | undefined;
  site_id?: string | undefined;
  required?: boolean | undefined;
  expiration_required?: boolean | undefined;
};

export type UpdateRegulatoryRequirementInput = {
  required?: boolean | undefined;
  expiration_required?: boolean | undefined;
};

export type RegulatoryBinderStatus = 'active' | 'archived';

export type RegulatoryBinder = {
  id: string;
  company_id: string;
  study_id: string | null;
  site_id: string | null;
  status: RegulatoryBinderStatus;
  created_at: string;
};

export type RegulatoryDocumentStatus =
  | 'missing'
  | 'draft'
  | 'pending_review'
  | 'current'
  | 'expiring_soon'
  | 'expired'
  | 'rejected'
  | 'archived';

export type RegulatoryDocument = {
  id: string;
  company_id: string;
  site_id: string | null;
  study_id: string | null;
  document_type_id: string;
  file_id: string | null;
  document_name: string;
  version: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  status: RegulatoryDocumentStatus;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
};

export type RegulatoryDocumentWithType = RegulatoryDocument & {
  document_type: Pick<DocumentType, 'id' | 'name' | 'category' | 'has_expiration'>;
};

export type DocumentVersionStatus =
  'pending_review' | 'approved' | 'rejected' | 'superseded' | 'archived';

export type DocumentVersion = {
  id: string;
  company_id: string;
  document_id: string | null;
  staff_document_id: string | null;
  previous_version_id: string | null;
  version: string;
  file_id: string;
  file: Pick<FileRecord, 'id' | 'file_name' | 'original_name' | 'file_size' | 'mime_type'> | null;
  checksum: string;
  is_current: boolean;
  status: DocumentVersionStatus;
  effective_date: string | null;
  expiration_date: string | null;
  replacement_reason: string | null;
  duplicate_of_version_id: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
};

export type DocumentHistoryEntry = {
  id: string;
  company_id: string;
  document_id: string | null;
  staff_document_id: string | null;
  version_id: string | null;
  old_status: string | null;
  new_status: string;
  changed_by: string | null;
  changed_at: string;
  reason: string | null;
};

export type CreateRegulatoryDocumentInput = {
  document_type_id: string;
  study_id?: string | undefined;
  site_id?: string | undefined;
  document_name: string;
  effective_date?: string | undefined;
  expiration_date?: string | undefined;
};

export type UploadDocumentVersionInput = {
  effective_date?: string | undefined;
  expiration_date?: string | undefined;
  replacement_reason?: string | undefined;
  confirm_duplicate?: boolean | undefined;
};

export type RejectDocumentInput = {
  reason: string;
};

export type ArchiveDocumentInput = {
  reason: string;
};

export type OverrideDocumentStatusInput = {
  new_status: RegulatoryDocumentStatus;
  reason: string;
};

export type DuplicateChecksumWarning = {
  duplicate_detected: true;
  matching_version: {
    id: string;
    version: string;
    uploaded_at: string;
    uploaded_by: string | null;
  };
};

export type StaffDocumentStatus = RegulatoryDocumentStatus;

export type StaffDocument = {
  id: string;
  company_id: string;
  user_id: string;
  site_id: string | null;
  document_type_id: string;
  file_id: string | null;
  version: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  status: StaffDocumentStatus;
  created_at: string;
  updated_at: string;
};

export type StaffDocumentWithType = StaffDocument & {
  document_type: Pick<DocumentType, 'id' | 'name' | 'category' | 'has_expiration'>;
};

export type CreateStaffDocumentInput = {
  user_id: string;
  document_type_id: string;
  site_id?: string | undefined;
  effective_date?: string | undefined;
  expiration_date?: string | undefined;
};

export type RegulatoryHealthScope = 'company' | 'site' | 'study' | 'staff';

export type RegulatoryHealthBreakdown = {
  current: number;
  expiring_soon: number;
  expired: number;
  missing: number;
  pending_review: number;
  rejected: number;
};

export type RegulatoryHealthScore = {
  scope: RegulatoryHealthScope;
  scope_id: string | null;
  score: number | null;
  numerator: number;
  denominator: number;
  breakdown: RegulatoryHealthBreakdown;
};

export type RegulatoryBinderTree = {
  binder: RegulatoryBinder;
  health: RegulatoryHealthScore;
  sections: Array<{
    category: string;
    documents: RegulatoryDocumentWithType[];
  }>;
  staff_documents: StaffDocumentWithType[];
};
