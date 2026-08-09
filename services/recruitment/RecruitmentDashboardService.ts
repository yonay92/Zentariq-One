import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PermissionService } from '@/services/permissions/PermissionService';
import { DatabaseError } from '@/lib/api/errors';
import type {
  Lead,
  LeadStatus,
  RecruitmentDashboard,
  RecruitmentDashboardFilters,
  RecruitmentFunnelCounts,
  RecruitmentOperationalMetrics,
} from '@/types/recruitment';
import type { RequestContext } from '@/types/api';

// Sprint 7.2 superset — was a stale 7-value (Sprint 5) list that silently
// corrupted funnel counts for any lead in one of the 13 statuses Sprint 7.1
// added (funnel[status] += 1 on an unindexed key is NaN). Kept in sync with
// the LeadStatus union in types/recruitment.ts.
const ALL_STATUSES: LeadStatus[] = [
  'new',
  'contact_attempted',
  'contacted',
  'voicemail_left',
  'interested',
  'not_interested',
  'prescreening',
  'prescreen_scheduled',
  'prescreen_in_progress',
  'prescreen_complete',
  'qualified',
  'not_qualified',
  'screening_scheduled',
  'screened',
  'screen_failed',
  'withdrawn',
  'waitlisted',
  'converted',
  'declined',
  'lost',
];

const HIGH_PRIORITIES: Lead['priority'][] = ['high', 'urgent'];

function startOfDayIso(date: Date): string {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
}

function startOfNextDayIso(date: Date): string {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).toISOString();
}

function daysBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / (1000 * 60 * 60 * 24);
}

export const RecruitmentDashboardService = {
  async get(
    filters: RecruitmentDashboardFilters,
    ctx: RequestContext,
  ): Promise<RecruitmentDashboard> {
    await PermissionService.requirePermission(ctx.user.id, 'view_recruitment_dashboard');

    const supabase = await createServerSupabaseClient();

    // Scope: company (always) + site/study/assigned_user filters — archived
    // leads never appear in an operational dashboard. This same scoped set
    // backs every metric below, so "default scope respects company, site,
    // study, and permission boundaries" holds uniformly, not just for some
    // cards.
    let leadsQuery = supabase
      .from('leads')
      .select(
        'id, status, priority, assigned_user_id, referral_source_id, next_contact_at, converted_at, created_at',
      )
      .eq('company_id', ctx.company.id)
      .is('archived_at', null);
    if (filters.site_id) leadsQuery = leadsQuery.eq('site_id', filters.site_id);
    if (filters.study_id) leadsQuery = leadsQuery.eq('study_id', filters.study_id);
    if (filters.assigned_user_id)
      leadsQuery = leadsQuery.eq('assigned_user_id', filters.assigned_user_id);

    const { data: leadRows, error } = await leadsQuery;
    if (error) throw new DatabaseError(error.message);

    type ScopedLead = {
      id: string;
      status: LeadStatus;
      priority: Lead['priority'];
      assigned_user_id: string | null;
      referral_source_id: string | null;
      next_contact_at: string | null;
      converted_at: string | null;
      created_at: string;
    };
    const leads = (leadRows as ScopedLead[]) ?? [];
    const leadById = new Map(leads.map((l) => [l.id, l]));

    const funnel = ALL_STATUSES.reduce((acc, status) => {
      acc[status] = 0;
      return acc;
    }, {} as RecruitmentFunnelCounts);
    for (const lead of leads) funnel[lead.status] += 1;

    const totalLeads = leads.length;
    const conversionRate = totalLeads > 0 ? funnel.converted / totalLeads : 0;

    const bySourceId = new Map<string | null, number>();
    for (const lead of leads) {
      bySourceId.set(lead.referral_source_id, (bySourceId.get(lead.referral_source_id) ?? 0) + 1);
    }
    const sourceIds = Array.from(bySourceId.keys()).filter((id): id is string => id !== null);
    const sourceNames = new Map<string, string>();
    if (sourceIds.length > 0) {
      const { data: sources } = await supabase
        .from('referral_sources')
        .select('id, name')
        .in('id', sourceIds);
      for (const source of (sources as Array<{ id: string; name: string }>) ?? []) {
        sourceNames.set(source.id, source.name);
      }
    }
    const byReferralSource = Array.from(bySourceId.entries())
      .map(([referral_source_id, count]) => ({
        referral_source_id,
        name: referral_source_id
          ? (sourceNames.get(referral_source_id) ?? 'Unknown')
          : 'No source recorded',
        count,
      }))
      .sort((a, b) => b.count - a.count);

    // ── Operational metrics ──────────────────────────────────────────────

    const now = new Date();
    const todayStart = startOfDayIso(now);
    const tomorrowStart = startOfNextDayIso(now);

    const newLeads = funnel.new;
    const unassignedLeads = leads.filter((l) => !l.assigned_user_id).length;
    const highPriorityLeads = leads.filter((l) => HIGH_PRIORITIES.includes(l.priority)).length;
    const qualifiedLeads = funnel.qualified;
    const screeningsScheduled = funnel.screening_scheduled;

    const followUpsDueToday = leads.filter(
      (l) =>
        l.next_contact_at && l.next_contact_at >= todayStart && l.next_contact_at < tomorrowStart,
    ).length;
    const overdueFollowUps = leads.filter(
      (l) => l.next_contact_at && l.next_contact_at < todayStart,
    ).length;
    const prescreensScheduledToday = leads.filter(
      (l) =>
        l.status === 'prescreen_scheduled' &&
        l.next_contact_at &&
        l.next_contact_at >= todayStart &&
        l.next_contact_at < tomorrowStart,
    ).length;

    const monthStartDefault = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const rangeFrom = filters.date_from ?? monthStartDefault;
    const rangeTo = filters.date_to ?? now.toISOString();
    const convertedThisMonth = leads.filter(
      (l) => l.converted_at && l.converted_at >= rangeFrom && l.converted_at <= rangeTo,
    ).length;

    // Average time-in-stage — computed from lead_status_history, the same
    // record Sprint 7.1 already writes for every status-changing action, so
    // no new schema is needed for this.
    let avgNewToContacted: number | null = null;
    let avgQualifiedToScreeningScheduled: number | null = null;
    if (leads.length > 0) {
      let historyQuery = supabase
        .from('lead_status_history')
        .select('lead_id, previous_status, new_status, changed_at')
        .eq('company_id', ctx.company.id)
        .in(
          'lead_id',
          leads.map((l) => l.id),
        )
        .order('changed_at', { ascending: true });
      if (filters.date_from) historyQuery = historyQuery.gte('changed_at', filters.date_from);
      if (filters.date_to) historyQuery = historyQuery.lte('changed_at', filters.date_to);

      const { data: historyRows, error: historyError } = await historyQuery;
      if (historyError) throw new DatabaseError(historyError.message);

      type HistoryRow = {
        lead_id: string;
        previous_status: LeadStatus | null;
        new_status: LeadStatus;
        changed_at: string;
      };
      const historyByLead = new Map<string, HistoryRow[]>();
      for (const row of (historyRows as HistoryRow[]) ?? []) {
        const list = historyByLead.get(row.lead_id) ?? [];
        list.push(row);
        historyByLead.set(row.lead_id, list);
      }

      const newToContactedDeltas: number[] = [];
      const qualifiedToScreeningDeltas: number[] = [];

      for (const [leadId, rows] of historyByLead) {
        const lead = leadById.get(leadId);
        if (!lead) continue;

        const newToContacted = rows.find(
          (r) => r.previous_status === 'new' && r.new_status === 'contacted',
        );
        if (newToContacted) {
          newToContactedDeltas.push(daysBetween(lead.created_at, newToContacted.changed_at));
        }

        const toScreeningScheduled = rows.find(
          (r) => r.previous_status === 'qualified' && r.new_status === 'screening_scheduled',
        );
        if (toScreeningScheduled) {
          const enteredQualified = [...rows]
            .filter(
              (r) => r.new_status === 'qualified' && r.changed_at < toScreeningScheduled.changed_at,
            )
            .pop();
          if (enteredQualified) {
            qualifiedToScreeningDeltas.push(
              daysBetween(enteredQualified.changed_at, toScreeningScheduled.changed_at),
            );
          }
        }
      }

      avgNewToContacted =
        newToContactedDeltas.length > 0
          ? newToContactedDeltas.reduce((a, b) => a + b, 0) / newToContactedDeltas.length
          : null;
      avgQualifiedToScreeningScheduled =
        qualifiedToScreeningDeltas.length > 0
          ? qualifiedToScreeningDeltas.reduce((a, b) => a + b, 0) /
            qualifiedToScreeningDeltas.length
          : null;
    }

    const metrics: RecruitmentOperationalMetrics = {
      new_leads: newLeads,
      follow_ups_due_today: followUpsDueToday,
      overdue_follow_ups: overdueFollowUps,
      unassigned_leads: unassignedLeads,
      high_priority_leads: highPriorityLeads,
      prescreens_scheduled_today: prescreensScheduledToday,
      screenings_scheduled: screeningsScheduled,
      qualified_leads: qualifiedLeads,
      converted_this_month: convertedThisMonth,
      avg_days_new_to_contacted: avgNewToContacted,
      avg_days_qualified_to_screening_scheduled: avgQualifiedToScreeningScheduled,
      conversion_rate: conversionRate,
    };

    return {
      funnel,
      total_leads: totalLeads,
      conversion_rate: conversionRate,
      by_referral_source: byReferralSource,
      metrics,
    };
  },
};
