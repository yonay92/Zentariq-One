import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PermissionService } from '@/services/permissions/PermissionService';
import { DatabaseError } from '@/lib/api/errors';
import { normalizePhone, normalizeEmail } from '@/lib/utils/leadNormalization';
import type {
  CheckDuplicatesInput,
  CheckDuplicatesResult,
  DuplicateMatch,
  DuplicateMatchReason,
  Lead,
} from '@/types/recruitment';
import type { RequestContext } from '@/types/api';

type ContactMatchRow = { lead_id: string };

// Matching by phone/email/name+DOB/name+postal-code is inherently a
// PHI-adjacent read (it reveals whether a given name/phone/email already
// exists in the system) — gated the same way as viewing a lead's contact
// info, not a separate new permission (materially the same class of action).
export const LeadDuplicateService = {
  async checkDuplicates(
    input: CheckDuplicatesInput,
    ctx: RequestContext,
  ): Promise<CheckDuplicatesResult> {
    await PermissionService.requirePermission(ctx.user.id, 'view_lead_phi');

    const supabase = await createServerSupabaseClient();
    const reasonsByLead = new Map<string, Set<DuplicateMatchReason>>();

    function record(rows: ContactMatchRow[] | null, reason: DuplicateMatchReason): void {
      for (const row of rows ?? []) {
        const set = reasonsByLead.get(row.lead_id) ?? new Set<DuplicateMatchReason>();
        set.add(reason);
        reasonsByLead.set(row.lead_id, set);
      }
    }

    const normalizedPhone = input.phone ? normalizePhone(input.phone) : null;
    if (normalizedPhone) {
      const { data, error } = await supabase
        .from('lead_contact_info')
        .select('lead_id')
        .eq('company_id', ctx.company.id)
        .eq('normalized_phone', normalizedPhone);
      if (error) throw new DatabaseError(error.message);
      record(data as ContactMatchRow[], 'phone_match');
    }

    const normalizedEmail = input.email ? normalizeEmail(input.email) : null;
    if (normalizedEmail) {
      const { data, error } = await supabase
        .from('lead_contact_info')
        .select('lead_id')
        .eq('company_id', ctx.company.id)
        .eq('normalized_email', normalizedEmail);
      if (error) throw new DatabaseError(error.message);
      record(data as ContactMatchRow[], 'email_match');
    }

    if (input.first_name && input.last_name && input.date_of_birth) {
      const { data, error } = await supabase
        .from('lead_contact_info')
        .select('lead_id')
        .eq('company_id', ctx.company.id)
        .ilike('first_name', input.first_name)
        .ilike('last_name', input.last_name)
        .eq('date_of_birth', input.date_of_birth);
      if (error) throw new DatabaseError(error.message);
      record(data as ContactMatchRow[], 'name_dob_match');
    }

    if (input.first_name && input.last_name && input.postal_code) {
      const { data, error } = await supabase
        .from('lead_contact_info')
        .select('lead_id')
        .eq('company_id', ctx.company.id)
        .ilike('first_name', input.first_name)
        .ilike('last_name', input.last_name)
        .ilike('postal_code', input.postal_code);
      if (error) throw new DatabaseError(error.message);
      record(data as ContactMatchRow[], 'name_postal_code_match');
    }

    if (reasonsByLead.size === 0) {
      return { possible_matches: [] };
    }

    // Duplicate detection deliberately includes archived leads — the whole
    // point is to catch a possible re-entry of someone already in the
    // system, archived or not (business rule: never silently merge, always
    // surface as a warning instead).
    const leadIds = Array.from(reasonsByLead.keys());
    const { data: leadRows, error: leadsError } = await supabase
      .from('leads')
      .select('id, initials, status, site_id, study_id, archived_at')
      .eq('company_id', ctx.company.id)
      .in('id', leadIds);
    if (leadsError) throw new DatabaseError(leadsError.message);

    const possibleMatches: DuplicateMatch[] = (
      (leadRows as Array<
        Pick<Lead, 'id' | 'initials' | 'status' | 'site_id' | 'study_id' | 'archived_at'>
      >) ?? []
    ).map((lead) => ({
      lead_id: lead.id,
      initials: lead.initials,
      status: lead.status,
      site_id: lead.site_id,
      study_id: lead.study_id,
      archived: lead.archived_at !== null,
      match_reasons: Array.from(reasonsByLead.get(lead.id) ?? []),
    }));

    return { possible_matches: possibleMatches };
  },
};
