import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { DatabaseError, NotFoundError } from '@/lib/api/errors';
import { normalizePhone, normalizeEmail } from '@/lib/utils/leadNormalization';
import type {
  CheckDuplicatesInput,
  CheckDuplicatesResult,
  DismissDuplicateInput,
  DuplicateMatch,
  DuplicateMatchReason,
  LeadDuplicateDismissal,
  Lead,
} from '@/types/recruitment';
import type { RequestContext } from '@/types/api';

type ContactMatchRow = { lead_id: string };

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

async function getDismissedPairs(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  companyId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('lead_duplicate_dismissals')
    .select('lead_id, matched_lead_id')
    .eq('company_id', companyId);
  if (error) throw new DatabaseError(error.message);

  const pairs = new Set<string>();
  for (const row of (data as Array<{ lead_id: string; matched_lead_id: string }>) ?? []) {
    pairs.add(pairKey(row.lead_id, row.matched_lead_id));
  }
  return pairs;
}

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
        if (input.lead_id && row.lead_id === input.lead_id) continue; // never match self
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

    // Dismissals only apply relative to a known lead_id — a fresh
    // (not-yet-created) lead has never dismissed anything.
    const dismissedPairs = input.lead_id
      ? await getDismissedPairs(supabase, ctx.company.id)
      : new Set<string>();

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
      previously_dismissed: input.lead_id
        ? dismissedPairs.has(pairKey(input.lead_id, lead.id))
        : false,
    }));

    return { possible_matches: possibleMatches };
  },

  // Records a "not a duplicate" decision — never merges, never deletes the
  // match from future checkDuplicates results (it still appears, flagged
  // previously_dismissed: true). Requires both leads to exist in this
  // company so a caller can't dismiss an arbitrary/foreign lead pair.
  async dismissDuplicate(
    leadId: string,
    input: DismissDuplicateInput,
    ctx: RequestContext,
  ): Promise<LeadDuplicateDismissal> {
    await PermissionService.requirePermission(ctx.user.id, 'dismiss_recruitment_duplicates');

    const supabase = await createServerSupabaseClient();
    const { data: leadRows, error: leadsError } = await supabase
      .from('leads')
      .select('id')
      .eq('company_id', ctx.company.id)
      .in('id', [leadId, input.matched_lead_id]);
    if (leadsError) throw new DatabaseError(leadsError.message);
    if (((leadRows as Array<{ id: string }>) ?? []).length !== 2) {
      throw new NotFoundError('Lead');
    }

    const { data, error } = await supabase
      .from('lead_duplicate_dismissals')
      .upsert(
        {
          company_id: ctx.company.id,
          lead_id: leadId,
          matched_lead_id: input.matched_lead_id,
          reason: input.reason,
          dismissed_by: ctx.user.id,
          dismissed_at: new Date().toISOString(),
        },
        { onConflict: 'company_id,lead_id,matched_lead_id' },
      )
      .select('id, company_id, lead_id, matched_lead_id, reason, dismissed_by, dismissed_at')
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to dismiss duplicate');

    // Reason is a short business justification, not PHI — safe to audit.
    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'lead_duplicate.dismissed',
      module: 'recruitment',
      record_type: 'lead_duplicate_dismissals',
      record_id: (data as LeadDuplicateDismissal).id,
      new_value: { lead_id: leadId, matched_lead_id: input.matched_lead_id, reason: input.reason },
    });

    return data as LeadDuplicateDismissal;
  },

  // Company-wide, phone/email-only duplicate signal used by LeadService.list()
  // for the Lead Table's "Duplicate warning" column/filter. Bounded to two
  // queries regardless of company size or page size — see the Sprint 7.2
  // plan for why name+DOB/name+postal-code matching (used by the full
  // checkDuplicates above) isn't part of this cheaper, list-level indicator.
  async getLeadsWithActiveDuplicateWarnings(ctx: RequestContext): Promise<Set<string>> {
    const supabase = await createServerSupabaseClient();

    const { data, error } = await supabase
      .from('lead_contact_info')
      .select('lead_id, normalized_phone, normalized_email')
      .eq('company_id', ctx.company.id);
    if (error) throw new DatabaseError(error.message);

    const rows =
      (data as Array<{
        lead_id: string;
        normalized_phone: string | null;
        normalized_email: string | null;
      }>) ?? [];

    const byPhone = new Map<string, string[]>();
    const byEmail = new Map<string, string[]>();
    for (const row of rows) {
      if (row.normalized_phone) {
        const list = byPhone.get(row.normalized_phone) ?? [];
        list.push(row.lead_id);
        byPhone.set(row.normalized_phone, list);
      }
      if (row.normalized_email) {
        const list = byEmail.get(row.normalized_email) ?? [];
        list.push(row.lead_id);
        byEmail.set(row.normalized_email, list);
      }
    }

    const candidatePairs = new Set<string>();
    function addGroupPairs(groups: Map<string, string[]>): void {
      for (const ids of groups.values()) {
        if (ids.length < 2) continue;
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            candidatePairs.add(pairKey(ids[i]!, ids[j]!));
          }
        }
      }
    }
    addGroupPairs(byPhone);
    addGroupPairs(byEmail);

    if (candidatePairs.size === 0) return new Set();

    const dismissedPairs = await getDismissedPairs(supabase, ctx.company.id);

    const flagged = new Set<string>();
    for (const pair of candidatePairs) {
      if (dismissedPairs.has(pair)) continue;
      const [a, b] = pair.split('|');
      flagged.add(a!);
      flagged.add(b!);
    }
    return flagged;
  },
};
