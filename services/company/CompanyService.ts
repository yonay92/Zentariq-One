import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotFoundError, DatabaseError } from '@/lib/api/errors';
import type { Company, CompanySettings, CompanyModule } from '@/types/users';
import type { RequestContext } from '@/types/api';

const DEFAULT_DOCUMENT_TYPES = [
  { name: 'Protocol', category: 'study', required_by_default: true },
  { name: 'ICF', category: 'study', required_by_default: true },
  { name: 'Investigator Brochure', category: 'study', required_by_default: true },
  { name: 'Schedule of Assessments', category: 'study', required_by_default: true },
  { name: 'Pharmacy Manual', category: 'study', required_by_default: false },
  { name: 'Laboratory Manual', category: 'study', required_by_default: false },
  { name: 'Other', category: 'study', required_by_default: false },
];

const DEFAULT_MODULES = [
  'dashboard',
  'task_center',
  'studies',
  'subjects',
  'visits',
  'charts',
  'regulatory',
  'analytics',
  'clinical_intelligence',
  'business_rules',
  'enterprise_document_center',
];

export const CompanyService = {
  async getCurrent(companyId: string): Promise<Company> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('companies')
      .select('id, name, legal_name, status, subscription_plan, timezone, created_at, updated_at')
      .eq('id', companyId)
      .single();

    if (error || !data) throw new NotFoundError('Company');
    return data as Company;
  },

  async getSettings(companyId: string): Promise<CompanySettings | null> {
    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from('company_settings')
      .select(
        'id, company_id, logo_file_id, primary_color, secondary_color, default_timezone, date_format, language, enable_ai, enable_task_center, created_at, updated_at',
      )
      .eq('company_id', companyId)
      .maybeSingle();

    return (data as CompanySettings) ?? null;
  },

  async updateSettings(
    input: Partial<Omit<CompanySettings, 'id' | 'company_id' | 'created_at' | 'updated_at'>>,
    ctx: RequestContext,
  ): Promise<CompanySettings> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_settings');

    const supabase = await createServerSupabaseClient();
    const { data: existing } = await supabase
      .from('company_settings')
      .select('id')
      .eq('company_id', ctx.company.id)
      .maybeSingle();

    let result;
    if (existing) {
      const { data, error } = await supabase
        .from('company_settings')
        .update(input)
        .eq('company_id', ctx.company.id)
        .select()
        .single();
      if (error || !data) throw new DatabaseError(error?.message ?? 'Update failed');
      result = data;
    } else {
      const { data, error } = await supabase
        .from('company_settings')
        .insert({ company_id: ctx.company.id, ...input })
        .select()
        .single();
      if (error || !data) throw new DatabaseError(error?.message ?? 'Insert failed');
      result = data;
    }

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'company.settings_updated',
      module: 'settings',
      record_type: 'company_settings',
      record_id: (result as { id: string }).id,
      new_value: input as Record<string, unknown>,
    });

    return result as CompanySettings;
  },

  async getModules(companyId: string): Promise<CompanyModule[]> {
    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from('company_modules')
      .select('id, company_id, module_key, is_enabled, created_at')
      .eq('company_id', companyId);

    return (data as CompanyModule[]) ?? [];
  },

  async provision(companyId: string, companyName: string): Promise<void> {
    const supabase = createAdminSupabaseClient();

    // Company settings
    await supabase
      .from('company_settings')
      .upsert({ company_id: companyId }, { onConflict: 'company_id', ignoreDuplicates: true });

    // Company modules
    await supabase.from('company_modules').upsert(
      DEFAULT_MODULES.map((key) => ({
        company_id: companyId,
        module_key: key,
        is_enabled: true,
      })),
      { onConflict: 'company_id,module_key', ignoreDuplicates: true },
    );

    // Seed system roles
    const roleDefs = [
      { key: 'admin', name: 'Administrator', description: 'Full system access' },
      { key: 'ceo', name: 'CEO', description: 'Executive read access' },
      { key: 'crc', name: 'CRC', description: 'Clinical Research Coordinator' },
      { key: 'data_entry', name: 'Data Entry', description: 'Chart data entry' },
      { key: 'regulatory', name: 'Regulatory', description: 'Regulatory document management' },
      { key: 'pi', name: 'PI', description: 'Principal Investigator' },
    ];

    const { data: roles } = await supabase
      .from('roles')
      .insert(
        roleDefs.map((r) => ({
          company_id: companyId,
          name: r.name,
          key: r.key,
          description: r.description,
          is_system_role: true,
        })),
      )
      .select('id, key');

    if (!roles) return;

    const { data: permissions } = await supabase.from('permissions').select('id, key');
    if (!permissions) return;

    const permMap = new Map(
      (permissions as Array<{ id: string; key: string }>).map((p) => [p.key, p.id]),
    );
    const roleMap = new Map(
      (roles as Array<{ id: string; key: string }>).map((r) => [r.key, r.id]),
    );

    // force_archive_study / force_archive_site / reopen_visit / override_regulatory_status
    // are deliberate, per-role overrides a company owner grants manually via
    // Settings > Roles — giving every admin the "all permissions" default
    // would defeat the point of that safeguard. view_subject_phi /
    // edit_subject_phi are granted to Administrator by default (product
    // decision — other roles still require a conscious per-role grant via
    // Settings > Roles, same override mechanism).
    const ADMIN_EXCLUDED_PERMISSIONS = new Set([
      'force_archive_study',
      'force_archive_site',
      'reopen_visit',
      'override_regulatory_status',
    ]);
    const adminPerms = Array.from(permMap.entries())
      .filter(([key]) => !ADMIN_EXCLUDED_PERMISSIONS.has(key))
      .map(([, id]) => id);
    const ceoPerms = [
      'view_dashboard',
      'view_studies',
      'view_subjects',
      'view_visits',
      'view_charts',
      'view_regulatory',
      'view_documents',
      'view_analytics',
      'view_audit_logs',
    ]
      .map((k) => permMap.get(k))
      .filter(Boolean) as string[];
    const crcPerms = [
      'view_dashboard',
      'view_studies',
      'view_subjects',
      'create_subject',
      'edit_subject',
      'view_visits',
      'manage_visits',
      'mark_chart_ready',
      'view_charts',
      'view_regulatory',
      'view_documents',
      'view_tasks',
      'complete_task',
      'view_leads',
      'create_lead',
      'edit_lead',
      'convert_lead',
      'view_staff_credentials',
    ]
      .map((k) => permMap.get(k))
      .filter(Boolean) as string[];
    const dataEntryPerms = [
      'view_dashboard',
      'view_charts',
      'mark_chart_entered',
      'view_tasks',
      'complete_task',
    ]
      .map((k) => permMap.get(k))
      .filter(Boolean) as string[];
    const regulatoryPerms = [
      'view_dashboard',
      'view_regulatory',
      'upload_regulatory_document',
      'edit_regulatory_document',
      'archive_regulatory_document',
      'manage_regulatory_requirements',
      'view_staff_credentials',
      'manage_staff_credentials',
      'view_regulatory_audit',
      'view_documents',
      'upload_documents',
      'view_tasks',
      'complete_task',
    ]
      .map((k) => permMap.get(k))
      .filter(Boolean) as string[];
    const piPerms = [
      'view_dashboard',
      'view_studies',
      'view_subjects',
      'view_visits',
      'view_regulatory',
      'view_staff_credentials',
    ]
      .map((k) => permMap.get(k))
      .filter(Boolean) as string[];

    const rolePermMap: Record<string, string[]> = {
      admin: adminPerms,
      ceo: ceoPerms,
      crc: crcPerms,
      data_entry: dataEntryPerms,
      regulatory: regulatoryPerms,
      pi: piPerms,
    };

    const inserts: Array<{
      company_id: string;
      role_id: string;
      permission_id: string;
      allowed: boolean;
    }> = [];
    for (const [roleKey, permIds] of Object.entries(rolePermMap)) {
      const roleId = roleMap.get(roleKey);
      if (!roleId) continue;
      for (const permId of permIds) {
        inserts.push({
          company_id: companyId,
          role_id: roleId,
          permission_id: permId,
          allowed: true,
        });
      }
    }

    if (inserts.length > 0) {
      await supabase.from('role_permissions').upsert(inserts, {
        onConflict: 'company_id,role_id,permission_id',
        ignoreDuplicates: true,
      });
    }

    // Seed default document types (supabase/seed/004_document_types.sql)
    await supabase.from('document_types').upsert(
      DEFAULT_DOCUMENT_TYPES.map((d) => ({
        company_id: companyId,
        name: d.name,
        category: d.category,
        required_by_default: d.required_by_default,
      })),
      { onConflict: 'company_id,name', ignoreDuplicates: true },
    );

    void companyName;
  },
};
