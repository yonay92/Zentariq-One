import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotFoundError, DatabaseError } from '@/lib/api/errors';
import { normalizePhone, normalizeEmail } from '@/lib/utils/leadNormalization';
import type { LeadContactInfo, UpsertLeadContactInfoInput } from '@/types/recruitment';
import type { RequestContext } from '@/types/api';

const CONTACT_INFO_COLUMNS =
  'id, company_id, site_id, lead_id, first_name, middle_name, last_name, preferred_name, date_of_birth, sex, gender_identity, preferred_language, phone_primary, phone_secondary, email, address_line_1, address_line_2, city, state, postal_code, country, preferred_contact_method, created_by, updated_by, created_at, updated_at';

// Deliberately queries `leads` directly rather than LeadService.getById —
// that method requires 'view_leads', a separate permission a PHI-only user
// isn't guaranteed to hold. Same pattern as SubjectContactService.
async function getLeadContext(
  leadId: string,
  ctx: RequestContext,
): Promise<{ site_id: string | null; initials: string | null }> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('leads')
    .select('site_id, initials')
    .eq('id', leadId)
    .eq('company_id', ctx.company.id)
    .single();

  if (error || !data) throw new NotFoundError('Lead');
  return data as { site_id: string | null; initials: string | null };
}

function generateInitials(firstName: string, lastName: string): string {
  const first = firstName.trim().charAt(0);
  const last = lastName.trim().charAt(0);
  return `${first}${last}`.toUpperCase();
}

export const LeadContactService = {
  async get(leadId: string, ctx: RequestContext): Promise<LeadContactInfo | null> {
    await PermissionService.requirePermission(ctx.user.id, 'view_lead_phi');
    await getLeadContext(leadId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from('lead_contact_info')
      .select(CONTACT_INFO_COLUMNS)
      .eq('lead_id', leadId)
      .eq('company_id', ctx.company.id)
      .maybeSingle();

    return (data as LeadContactInfo | null) ?? null;
  },

  async upsert(
    leadId: string,
    input: UpsertLeadContactInfoInput,
    ctx: RequestContext,
  ): Promise<LeadContactInfo> {
    await PermissionService.requirePermission(ctx.user.id, 'edit_lead_phi');
    const lead = await getLeadContext(leadId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data: existing } = await supabase
      .from('lead_contact_info')
      .select('id')
      .eq('lead_id', leadId)
      .eq('company_id', ctx.company.id)
      .maybeSingle();

    const payload = {
      first_name: input.first_name,
      middle_name: input.middle_name ?? null,
      last_name: input.last_name,
      preferred_name: input.preferred_name ?? null,
      date_of_birth: input.date_of_birth ?? null,
      sex: input.sex ?? null,
      gender_identity: input.gender_identity ?? null,
      preferred_language: input.preferred_language ?? null,
      phone_primary: input.phone_primary,
      phone_secondary: input.phone_secondary ?? null,
      email: input.email ?? null,
      address_line_1: input.address_line_1 ?? null,
      address_line_2: input.address_line_2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postal_code: input.postal_code ?? null,
      country: input.country ?? null,
      preferred_contact_method: input.preferred_contact_method,
      // Duplicate-detection fields only — never displayed, the entered
      // values above remain the source of truth for display.
      normalized_phone: normalizePhone(input.phone_primary),
      normalized_email: input.email ? normalizeEmail(input.email) : null,
    };

    const isCreate = !existing;
    const { data, error } = isCreate
      ? await supabase
          .from('lead_contact_info')
          .insert({
            company_id: ctx.company.id,
            site_id: lead.site_id,
            lead_id: leadId,
            ...payload,
            created_by: ctx.user.id,
            updated_by: ctx.user.id,
          })
          .select(CONTACT_INFO_COLUMNS)
          .single()
      : await supabase
          .from('lead_contact_info')
          .update({ ...payload, updated_by: ctx.user.id })
          .eq('id', (existing as { id: string }).id)
          .eq('company_id', ctx.company.id)
          .select(CONTACT_INFO_COLUMNS)
          .single();

    if (error || !data) {
      throw new DatabaseError(error?.message ?? 'Failed to save lead contact information');
    }

    // Initials aren't PHI-gated (the pipeline list already shows them to
    // anyone with view_leads), so auto-generating them uses the plain
    // lead.* audit action rather than the PHI-scoped one below.
    if (!lead.initials) {
      const generated = generateInitials(input.first_name, input.last_name);
      const { data: initialsUpdated, error: initialsError } = await supabase
        .from('leads')
        .update({ initials: generated })
        .eq('id', leadId)
        .eq('company_id', ctx.company.id)
        .is('initials', null)
        .select('id');

      if (!initialsError && initialsUpdated && initialsUpdated.length > 0) {
        await AuditService.log({
          company_id: ctx.company.id,
          site_id: lead.site_id,
          user_id: ctx.user.id,
          action: 'lead.initials_generated',
          module: 'recruitment',
          record_type: 'leads',
          record_id: leadId,
          new_value: { initials: generated },
        });
      }
    }

    // Explicit field-name whitelist, never raw PHI values.
    await AuditService.log({
      company_id: ctx.company.id,
      site_id: lead.site_id,
      user_id: ctx.user.id,
      action: isCreate ? 'lead_contact_info.created' : 'lead_contact_info.updated',
      module: 'recruitment',
      record_type: 'lead_contact_info',
      record_id: (data as LeadContactInfo).id,
      new_value: { updated_fields: Object.keys(payload) },
    });

    return data as LeadContactInfo;
  },
};
