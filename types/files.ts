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
  site_id?: string | null;
};
