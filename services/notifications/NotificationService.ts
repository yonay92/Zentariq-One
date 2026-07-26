import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import type {
  NotificationDispatchInput,
  Notification,
  NotificationPreference,
  NotificationEventType,
} from '@/types/notifications';

const DEFAULT_PRIORITIES: Record<NotificationEventType, 'critical' | 'high' | 'medium' | 'low'> = {
  task_created: 'medium',
  task_assigned: 'high',
  task_overdue: 'critical',
  task_completed: 'low',
  document_expiring: 'high',
  document_expired: 'critical',
  document_uploaded: 'low',
  chart_ready: 'high',
  chart_overdue: 'critical',
  visit_out_of_window: 'high',
  sponsor_visit_approaching: 'high',
  ai_review_pending: 'high',
  ai_request_failed: 'high',
  subject_status_changed: 'medium',
  user_invited: 'high',
  ai_budget_warning: 'high',
  study_activated: 'medium',
  protocol_amendment: 'high',
  business_rule_failed: 'high',
};

const DEFAULT_TITLES: Record<NotificationEventType, string> = {
  task_created: 'New task: {task_title}',
  task_assigned: 'Task assigned to you: {task_title}',
  task_overdue: 'Overdue task: {task_title}',
  task_completed: 'Task completed: {task_title}',
  document_expiring: 'Document expiring in {days} days: {doc_name}',
  document_expired: 'Document expired: {doc_name}',
  document_uploaded: 'New document uploaded: {doc_name}',
  chart_ready: 'Chart ready for entry: {visit_name}',
  chart_overdue: 'Chart overdue: {subject_number} — {visit_name}',
  visit_out_of_window: 'Visit out of window: {subject_number}',
  sponsor_visit_approaching: 'Sponsor visit in {days} days',
  ai_review_pending: 'AI analysis ready for review: {agent_name}',
  ai_request_failed: 'AI request failed — please retry',
  subject_status_changed: 'Subject {subject_number} status: {new_status}',
  user_invited: "You've been invited to Zentariq One",
  ai_budget_warning: 'AI token budget at {pct}% for this month',
  study_activated: 'Study activated: {study_name}',
  protocol_amendment: 'Protocol amended: {study_name}',
  business_rule_failed: 'Business rule error: {rule_name}',
};

function interpolate(template: string, ctx: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => ctx[key as string] ?? `{${key}}`);
}

export const NotificationService = {
  async dispatch(input: NotificationDispatchInput): Promise<void> {
    try {
      const recipients = await resolveRecipients(input);
      if (recipients.length === 0) return;

      const supabase = createAdminSupabaseClient();
      const priority = input.priority ?? DEFAULT_PRIORITIES[input.type] ?? 'medium';
      const titleTemplate = input.customTitle ?? DEFAULT_TITLES[input.type] ?? input.type;
      const title = interpolate(titleTemplate, input.context ?? {});
      const body = input.customBody ? interpolate(input.customBody, input.context ?? {}) : null;

      for (const userId of recipients) {
        const prefs = await getPreferences(userId, input.type);
        if (!prefs.in_app) continue;

        const { data: notification, error } = await supabase
          .from('notifications')
          .insert({
            company_id: input.companyId,
            user_id: userId,
            type: input.type,
            title,
            body,
            related_module: input.relatedModule ?? null,
            related_record_id: input.relatedRecordId ?? null,
            related_record_type: input.relatedRecordType ?? null,
            priority,
            is_read: false,
          })
          .select('id')
          .single();

        if (error) {
          logger.error('NotificationService.dispatch: insert failed', {
            error: error.message,
            type: input.type,
            userId,
          });
          continue;
        }

        if (prefs.email && notification) {
          await queueEmail(
            userId,
            notification.id as string,
            input.companyId,
            title,
            body ?? '',
            priority,
            supabase,
          );
        }
      }
    } catch (err) {
      // Notification failures must never crash the primary operation
      logger.error('NotificationService.dispatch: unexpected error', {
        error: err instanceof Error ? err.message : String(err),
        type: input.type,
      });
    }
  },

  async initializeDefaultPreferences(userId: string, companyId: string): Promise<void> {
    const supabase = createAdminSupabaseClient();
    const eventTypes = Object.keys(DEFAULT_PRIORITIES) as NotificationEventType[];

    const rows = eventTypes.map((event_type) => ({
      company_id: companyId,
      user_id: userId,
      event_type,
      in_app: true,
      email: true,
    }));

    const { error } = await supabase.from('notification_preferences').insert(rows);

    if (error) {
      logger.error('NotificationService.initializeDefaultPreferences: failed', {
        error: error.message,
        userId,
      });
    }
  },

  async markAsRead(notificationId: string, userId: string): Promise<void> {
    const supabase = await createServerSupabaseClient();
    await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', notificationId)
      .eq('user_id', userId);
  },

  async markAllAsRead(userId: string, companyId: string): Promise<void> {
    const supabase = await createServerSupabaseClient();
    await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('company_id', companyId)
      .eq('is_read', false);
  },

  async getUnreadCount(userId: string, companyId: string): Promise<number> {
    const supabase = await createServerSupabaseClient();
    const { count } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('company_id', companyId)
      .eq('is_read', false);

    return count ?? 0;
  },

  async getUserNotifications(
    userId: string,
    companyId: string,
    limit: number = 50,
    isRead?: boolean,
  ): Promise<Notification[]> {
    const supabase = await createServerSupabaseClient();
    let query = supabase
      .from('notifications')
      .select(
        'id, company_id, user_id, type, title, body, related_module, related_record_id, related_record_type, priority, is_read, read_at, created_at',
      )
      .eq('user_id', userId)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (isRead !== undefined) {
      query = query.eq('is_read', isRead);
    }

    const { data } = await query;
    return (data as Notification[]) ?? [];
  },

  async getUserPreferences(userId: string, companyId: string): Promise<NotificationPreference[]> {
    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from('notification_preferences')
      .select('id, company_id, user_id, event_type, in_app, email, created_at, updated_at')
      .eq('user_id', userId)
      .eq('company_id', companyId)
      .order('event_type');

    return (data as NotificationPreference[]) ?? [];
  },

  async updatePreference(
    userId: string,
    companyId: string,
    eventType: string,
    channels: { in_app: boolean; email: boolean },
  ): Promise<void> {
    const supabase = await createServerSupabaseClient();
    await supabase.from('notification_preferences').upsert(
      {
        company_id: companyId,
        user_id: userId,
        event_type: eventType,
        in_app: channels.in_app,
        email: channels.email,
      },
      { onConflict: 'user_id,event_type' },
    );
  },
};

async function resolveRecipients(input: NotificationDispatchInput): Promise<string[]> {
  if (input.recipientUserId) return [input.recipientUserId];

  if (input.recipientRole && input.siteId) {
    const supabase = createAdminSupabaseClient();
    const { data } = await supabase
      .from('user_roles')
      .select('user_id, roles!inner(key)')
      .eq('company_id', input.companyId)
      .eq('roles.key', input.recipientRole);

    if (!data) return [];

    const userIds = (data as Array<{ user_id: string }>).map((r) => r.user_id);

    // Filter by site access
    const { data: siteUsers } = await supabase
      .from('user_sites')
      .select('user_id')
      .eq('site_id', input.siteId)
      .in('user_id', userIds);

    return ((siteUsers as Array<{ user_id: string }>) ?? []).map((r) => r.user_id);
  }

  return [];
}

async function getPreferences(
  userId: string,
  eventType: string,
): Promise<{ in_app: boolean; email: boolean }> {
  const supabase = createAdminSupabaseClient();
  const { data } = await supabase
    .from('notification_preferences')
    .select('in_app, email')
    .eq('user_id', userId)
    .eq('event_type', eventType)
    .maybeSingle();

  return data ?? { in_app: true, email: true };
}

async function queueEmail(
  userId: string,
  notificationId: string,
  companyId: string,
  subject: string,
  body: string,
  priority: string,
  supabase: ReturnType<typeof createAdminSupabaseClient>,
): Promise<void> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('email')
    .eq('id', userId)
    .single();

  if (!profile) return;

  const isCriticalOrHigh = priority === 'critical' || priority === 'high';
  const htmlBody = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto"><p>${body || subject}</p><p style="color:#64748b;font-size:12px">This is an automated notification from Zentariq One. Priority: ${priority}</p></div>`;

  await supabase.from('notification_email_queue').insert({
    company_id: companyId,
    user_id: userId,
    notification_id: notificationId,
    email: (profile as { email: string }).email,
    subject: isCriticalOrHigh ? `[URGENT] ${subject}` : subject,
    html_body: htmlBody,
    status: 'pending',
    attempts: 0,
  });
}
