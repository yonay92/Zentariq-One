// Supabase Edge Function: regulatory-expiration-checker
// Runs on a daily cron schedule (pg_cron, wired in migration 016 — see that
// migration's "SCHEDULED EXPIRATION CHECKS" section for the Vault secrets
// required before the schedule can actually invoke this function).
//
// Recomputes the status of every regulatory_documents/staff_documents row
// currently 'current' or 'expiring_soon' against its expiration_date and
// document_type's configured alert threshold, transitioning it to
// 'expiring_soon'/'expired' as needed. Writes a document_history row and an
// audit_logs entry per transition, and dispatches a document_expiring/
// document_expired notification via the same notifications/
// notification_preferences tables NotificationService.dispatch() uses in the
// Next.js app — duplicated here (not imported) because Edge Functions run in
// Deno and cannot import Node service code, the same split already used by
// visit-status-checker.
//
// Idempotent: only rows whose COMPUTED status differs from their STORED
// status are updated, and only those transitions dispatch a notification —
// running this twice in a row is a no-op the second time.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const BATCH_SIZE = 200;
const ACTIVE_STATUSES = ['current', 'expiring_soon'];

type DocumentRow = {
  id: string;
  company_id: string;
  site_id: string | null;
  study_id?: string | null;
  document_name?: string;
  expiration_date: string;
  status: string;
  document_type: { default_alert_days: number[] } | { default_alert_days: number[] }[] | null;
};

function computeStatus(
  expirationDate: string,
  alertDays: number[],
): 'current' | 'expiring_soon' | 'expired' {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(expirationDate);
  const daysUntilExpiry = Math.floor((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (daysUntilExpiry < 0) return 'expired';
  const threshold = alertDays.length > 0 ? Math.max(...alertDays) : 90;
  if (daysUntilExpiry <= threshold) return 'expiring_soon';
  return 'current';
}

function alertDaysOf(row: DocumentRow): number[] {
  const dt = row.document_type;
  if (!dt) return [90, 60, 30, 14, 7];
  const record = Array.isArray(dt) ? dt[0] : dt;
  return record?.default_alert_days ?? [90, 60, 30, 14, 7];
}

Deno.serve(async (_req: Request) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(JSON.stringify({ error: 'Missing Supabase credentials' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    async function dispatchNotification(
      companyId: string,
      siteId: string | null,
      eventType: 'document_expiring' | 'document_expired',
      docName: string,
      days: number,
    ): Promise<void> {
      // Recipients: anyone in the company (site-scoped if siteId is set) who
      // holds view_regulatory — mirrors NotificationService's recipientRole
      // resolution path without importing it.
      const { data: roleUsers } = await supabase
        .from('user_roles')
        .select('user_id, roles!inner(role_permissions!inner(allowed, permissions!inner(key)))')
        .eq('company_id', companyId);

      type RoleUserRow = {
        user_id: string;
        roles: { role_permissions: Array<{ allowed: boolean; permissions: { key: string } }> };
      };
      const eligible = ((roleUsers ?? []) as unknown as RoleUserRow[])
        .filter((r) =>
          r.roles.role_permissions.some(
            (rp) => rp.allowed && rp.permissions.key === 'view_regulatory',
          ),
        )
        .map((r) => r.user_id);

      let recipients = eligible;
      if (siteId) {
        const { data: siteUsers } = await supabase
          .from('user_sites')
          .select('user_id')
          .eq('site_id', siteId)
          .in('user_id', eligible);
        recipients = ((siteUsers ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
      }

      const title =
        eventType === 'document_expiring'
          ? `Document expiring in ${days} days: ${docName}`
          : `Document expired: ${docName}`;
      const priority = eventType === 'document_expiring' ? 'high' : 'critical';

      for (const userId of recipients) {
        const { data: prefs } = await supabase
          .from('notification_preferences')
          .select('in_app, email')
          .eq('user_id', userId)
          .eq('event_type', eventType)
          .maybeSingle();

        const inApp = (prefs as { in_app: boolean } | null)?.in_app ?? true;
        const email = (prefs as { email: boolean } | null)?.email ?? true;
        if (!inApp) continue;

        const { data: notification } = await supabase
          .from('notifications')
          .insert({
            company_id: companyId,
            user_id: userId,
            type: eventType,
            title,
            body: null,
            related_module: 'regulatory',
            priority,
            is_read: false,
          })
          .select('id')
          .single();

        if (email && notification) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('email')
            .eq('id', userId)
            .single();

          if (profile) {
            await supabase.from('notification_email_queue').insert({
              company_id: companyId,
              user_id: userId,
              notification_id: (notification as { id: string }).id,
              email: (profile as { email: string }).email,
              subject: priority === 'critical' ? `[URGENT] ${title}` : title,
              html_body: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto"><p>${title}</p></div>`,
              status: 'pending',
              attempts: 0,
            });
          }
        }
      }
    }

    async function checkTable(
      table: 'regulatory_documents' | 'staff_documents',
      module: 'regulatory_document' | 'staff_document',
    ): Promise<{ checked: number; transitioned: number }> {
      const { data: batch, error: fetchError } = await supabase
        .from(table)
        .select(
          `id, company_id, site_id${table === 'regulatory_documents' ? ', study_id, document_name' : ''}, expiration_date, status, document_type:document_types(default_alert_days)`,
        )
        .in('status', ACTIVE_STATUSES)
        .not('expiration_date', 'is', null)
        .limit(BATCH_SIZE);

      if (fetchError) {
        console.error(`[regulatory-expiration-checker] ${table} fetch error:`, fetchError.message);
        return { checked: 0, transitioned: 0 };
      }

      const rows = (batch ?? []) as DocumentRow[];
      let transitioned = 0;

      for (const row of rows) {
        const computed = computeStatus(row.expiration_date, alertDaysOf(row));
        if (computed === row.status) continue;

        const { error: updateError } = await supabase
          .from(table)
          .update({ status: computed })
          .eq('id', row.id)
          .eq('status', row.status);

        if (updateError) {
          console.error(
            `[regulatory-expiration-checker] update failed for ${row.id}:`,
            updateError.message,
          );
          continue;
        }

        const historyRow: Record<string, unknown> = {
          company_id: row.company_id,
          old_status: row.status,
          new_status: computed,
          changed_by: null,
          reason: 'Automatic expiration check',
        };
        if (table === 'regulatory_documents') historyRow.document_id = row.id;
        else historyRow.staff_document_id = row.id;
        await supabase.from('document_history').insert(historyRow);

        await supabase.from('audit_logs').insert({
          company_id: row.company_id,
          site_id: row.site_id,
          user_id: null,
          action: `${module}.status_changed`,
          module: 'regulatory',
          record_type: table,
          record_id: row.id,
          old_value: { status: row.status },
          new_value: { status: computed, expiration_date: row.expiration_date },
        });

        if (computed === 'expiring_soon' || computed === 'expired') {
          const expiry = new Date(row.expiration_date);
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const days = Math.max(
            0,
            Math.floor((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)),
          );
          await dispatchNotification(
            row.company_id,
            row.site_id,
            computed === 'expiring_soon' ? 'document_expiring' : 'document_expired',
            row.document_name ?? 'Staff credential',
            days,
          );
        }

        transitioned++;
      }

      return { checked: rows.length, transitioned };
    }

    const [documents, staffDocuments] = await Promise.all([
      checkTable('regulatory_documents', 'regulatory_document'),
      checkTable('staff_documents', 'staff_document'),
    ]);

    const summary = {
      regulatory_documents: documents,
      staff_documents: staffDocuments,
    };

    console.log(`[regulatory-expiration-checker] ${JSON.stringify(summary)}`);

    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[regulatory-expiration-checker] unexpected error:', message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
