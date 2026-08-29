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

export type FileLink = {
  id: string;
  company_id: string;
  file_id: string;
  site_id: string | null;
  module: string;
  record_id: string;
  created_by: string | null;
  created_at: string;
};

export type LinkFileToRecordInput = {
  file_id: string;
  module: string;
  record_id: string;
  site_id?: string | null | undefined;
};

/**
 * The closed set of modules allowed to link files via FileService.linkForModule
 * (Milestone 3's module retrofits). Deliberately separate from — and stricter
 * than — LinkFileToRecordInput's `module: string`, which backs the generic
 * Document Center's own public linking API and must stay exactly as
 * permissive as it already is (e.g. tests/e2e/documents.spec.ts links with
 * module: 'subjects', which is not one of these values).
 */
export type DocumentCenterModule =
  | 'subject_documents'
  | 'study_documents'
  | 'study_drafts'
  | 'staff_documents'
  | 'regulatory_documents';

export type LinkFileForModuleInput = {
  file_id: string;
  module: DocumentCenterModule;
  record_id: string;
  site_id?: string | null | undefined;
};

export type FileWithLinks = FileRecord & { links: FileLink[] };

export type ListFilesFilters = {
  module?: string | undefined;
  uploaded_by?: string | undefined;
  uploaded_after?: string | undefined;
  uploaded_before?: string | undefined;
};
