import type { DuplicateMatchReason } from '@/types/recruitment';

// Shared between the contact-info duplicate-check warning and the lead
// profile's Possible Duplicates section so a given match reason always
// reads the same way everywhere.
export const DUPLICATE_MATCH_REASON_LABEL: Record<DuplicateMatchReason, string> = {
  phone_match: 'same phone number',
  email_match: 'same email address',
  name_dob_match: 'same name and date of birth',
  name_postal_code_match: 'same name and postal code',
};
