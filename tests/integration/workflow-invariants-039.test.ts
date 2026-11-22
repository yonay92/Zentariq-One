// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { BusinessRuleError, ConflictError } from '@/lib/api/errors';
import { StudyService } from '@/services/studies/StudyService';
import { VisitTemplateService } from '@/services/visit-templates/VisitTemplateService';
import { SubjectService } from '@/services/subjects/SubjectService';
import { VisitService } from '@/services/visits/VisitService';
import { ChartService } from '@/services/charts/ChartService';
import { LeadService } from '@/services/recruitment/LeadService';
import { POST as subjectStatusPOST } from '@/app/api/subjects/[id]/status/route';
import { POST as sequenceExceptionPOST } from '@/app/api/subjects/[id]/visits/[visitId]/sequence-exception/route';
import type { RequestContext } from '@/types/api';
import type { Visit } from '@/types/subjects';
import {
  rehearsalDbEnabled,
  startProxy,
  clientFor,
  sessionClientFor,
  fxId,
} from './db/localRehearsalDb';

// G8 M4 migration 039 — the application's own workflows still work on a
// database that enforces the workflow invariants, and the new rules surface
// through the app as designed (409 for 23514, sequence exceptions usable).
// Real services and route handlers run unchanged; only the two client
// factories point at the disposable local PostgREST (migrations 001–039 +
// synthetic fixtures). Skipped unless the rehearsal environment is set.

const CA = fxId('CA');
const A1 = fxId('A1');
let proxy: Awaited<ReturnType<typeof startProxy>>;
let admin: SupabaseClient;
let caller = 'A_ADMIN';
const run = Date.now().toString(36);
const today = new Date().toISOString().slice(0, 10);

function ctxFor(user: string): RequestContext {
  caller = user;
  const now = new Date().toISOString();
  return {
    user: {
      id: fxId(user),
      company_id: CA,
      full_name: user,
      email: `${user.toLowerCase()}@example.test`,
      phone: null,
      avatar_file_id: null,
      status: 'active',
      last_login_at: null,
      created_at: now,
      updated_at: now,
    },
    company: {
      id: CA,
      name: 'Tenant A',
      legal_name: 'Tenant A',
      status: 'active',
      subscription_plan: null,
      timezone: 'UTC',
      created_at: now,
      updated_at: now,
    },
  } as unknown as RequestContext;
}

async function visitsOf(subjectId: string): Promise<Visit[]> {
  const { data, error } = await admin
    .from('visits')
    .select('id, visit_name, status, target_date, window_start, window_end, visit_template_item_id')
    .eq('subject_id', subjectId);
  expect(error).toBeNull();
  return data as Visit[];
}
const byName = (vs: Visit[], name: string) => vs.find((v) => v.visit_name === name) as Visit;

async function startVisit(subjectId: string, visitId: string, user = 'A_ADMIN') {
  await VisitService.confirmVisit(subjectId, visitId, ctxFor(user));
  await VisitService.startVisit(subjectId, visitId, ctxFor(user));
}

describe.skipIf(!rehearsalDbEnabled)('G8 M4 039 — application workflows on a 039 database', () => {
  let studyId = '';
  let subjectId = '';

  beforeAll(async () => {
    proxy = await startProxy();
    admin = clientFor(proxy.url, 'A_ADMIN');
    vi.mocked(createServerSupabaseClient).mockImplementation(
      async () => sessionClientFor(proxy.url, caller) as never,
    );
    vi.mocked(createAdminSupabaseClient).mockImplementation(
      () => clientFor(proxy.url, 'service_role') as never,
    );
  });
  afterEach(() => {
    vi.mocked(createServerSupabaseClient).mockImplementation(
      async () => sessionClientFor(proxy.url, caller) as never,
    );
    vi.mocked(createAdminSupabaseClient).mockImplementation(
      () => clientFor(proxy.url, 'service_role') as never,
    );
  });
  afterAll(async () => {
    await proxy?.close();
  });

  it('study set-up through the services: create (draft) → template → approve → assign site → activate', async () => {
    const study = await StudyService.create({ study_name: `E2 039 ${run}` }, ctxFor('A_ADMIN'));
    expect(study.status).toBe('draft');
    studyId = study.id;

    await expect(StudyService.activateStudy(studyId, ctxFor('A_ADMIN'))).rejects.toThrow(
      BusinessRuleError,
    );

    const template = await VisitTemplateService.createTemplate(
      studyId,
      [
        { visit_name: 'Screening', visit_order: 1, offset_days: -14, is_required: true },
        {
          visit_name: 'Baseline',
          visit_order: 2,
          offset_days: 0,
          is_required: true,
          is_baseline: true,
        },
        {
          visit_name: 'Week 2',
          visit_order: 3,
          offset_days: 14,
          window_before: 3,
          window_after: 3,
          is_required: true,
        },
        {
          visit_name: 'Week 4',
          visit_order: 4,
          offset_days: 28,
          window_before: 3,
          window_after: 3,
          is_required: true,
        },
      ],
      ctxFor('A_ADMIN'),
    );
    expect(template.status).toBe('draft');
    const approved = await VisitTemplateService.approveTemplate(template.id, ctxFor('A_ADMIN'));
    expect(approved.status).toBe('approved');
    await StudyService.assignSites(studyId, [A1], ctxFor('A_ADMIN'));
    const active = await StudyService.activateStudy(studyId, ctxFor('A_ADMIN'));
    expect(active.status).toBe('active');
  });

  it('a subject is created through SubjectService.create (pre_screening) and the pre-baseline visits are generated as scheduled', async () => {
    const subject = await SubjectService.create(
      { site_id: A1, study_id: studyId, subject_number: `E2-${run}` },
      // The synthetic CRC role has no view_studies (fixture limitation, also on 038),
      // so SubjectService.create cannot read the study as that user.
      ctxFor('A_ADMIN'),
    );
    subjectId = subject.id;
    expect(subject.status).toBe('pre_screening');
    const vs = await visitsOf(subjectId);
    expect(vs.map((v) => [v.visit_name, v.status]).sort()).toEqual([
      ['Baseline', 'scheduled'],
      ['Screening', 'scheduled'],
    ]);
  });

  it('visit flow: Baseline is locked by Screening (app), Screening completes, Baseline completes and generates the schedule', async () => {
    let vs = await visitsOf(subjectId);
    await startVisit(subjectId, byName(vs, 'Baseline').id);
    await expect(
      SubjectService.completeBaselineVisit(subjectId, { baseline_date: today }, ctxFor('A_ADMIN')),
    ).rejects.toThrow(BusinessRuleError);

    await startVisit(subjectId, byName(vs, 'Screening').id);
    const screening = await SubjectService.completeVisit(
      subjectId,
      byName(vs, 'Screening').id,
      { scheduled_date: today },
      ctxFor('A_ADMIN'),
    );
    expect(screening.status).toBe('completed');

    const subject = await SubjectService.completeBaselineVisit(
      subjectId,
      { baseline_date: today },
      ctxFor('A_ADMIN'),
    );
    expect(subject.baseline_date).toBe(today);
    vs = await visitsOf(subjectId);
    expect(byName(vs, 'Baseline').status).toBe('completed');
    expect(byName(vs, 'Week 2').status).toBe('scheduled');
    expect(byName(vs, 'Week 4').status).toBe('scheduled');
  });

  it('C-1: the generic status route cannot randomize without randomization details → 409 from the database rule', async () => {
    await SubjectService.updateStatus(subjectId, 'screening', ctxFor('A_ADMIN'));
    caller = 'A_ADMIN';
    const res = await subjectStatusPOST(
      new NextRequest(`http://localhost/api/subjects/${subjectId}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'randomized' }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: subjectId }) },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({
      code: 'CONFLICT',
      message: 'Randomization requires a completed baseline and randomization details.',
    });
    const { data } = await admin.from('subjects').select('status').eq('id', subjectId).single();
    expect((data as { status: string }).status).toBe('screening');
  });

  it('randomize() and activation still work through the services', async () => {
    const randomized = await SubjectService.randomize(
      subjectId,
      { randomization_number: `RN-${run}`, randomization_date: today },
      ctxFor('A_ADMIN'),
    );
    expect(randomized.status).toBe('randomized');
    const active = await SubjectService.updateStatus(subjectId, 'active', ctxFor('A_ADMIN'));
    expect(active.status).toBe('active');
  });

  it('M4-D5: Week 4 is locked by Week 2; an authorized exception (API route) lets it complete once', async () => {
    let vs = await visitsOf(subjectId);
    const week4 = byName(vs, 'Week 4');
    await startVisit(subjectId, week4.id);

    await expect(
      SubjectService.completeVisit(
        subjectId,
        week4.id,
        { scheduled_date: week4.target_date as string },
        ctxFor('A_ADMIN'),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Idempotent across runs on the same database: switch off a grant left by a
    // previous run, the same way Settings > Roles does (RoleService: upsert of
    // allowed; authenticated has no DELETE on role_permissions).
    const { data: permRow } = await admin
      .from('permissions')
      .select('id')
      .eq('key', 'override_visit_sequence')
      .single();
    const setGrant = (allowed: boolean) =>
      admin.from('role_permissions').upsert(
        {
          company_id: CA,
          role_id: fxId('R_A_ADMIN'),
          permission_id: (permRow as { id: string }).id,
          allowed,
        },
        { onConflict: 'company_id,role_id,permission_id' },
      );
    expect((await setGrant(false)).error).toBeNull();

    // Administrator does NOT get override_visit_sequence by default → 403
    caller = 'A_ADMIN';
    const post = (reason: string) =>
      sequenceExceptionPOST(
        new NextRequest(
          `http://localhost/api/subjects/${subjectId}/visits/${week4.id}/sequence-exception`,
          {
            method: 'POST',
            body: JSON.stringify({ reason }),
            headers: { 'content-type': 'application/json' },
          },
        ),
        { params: Promise.resolve({ id: subjectId, visitId: week4.id }) },
      );
    expect((await post('Week 2 done at the partner site; records pending')).status).toBe(403);

    // The company owner grants the override to the Administrator role explicitly (Settings > Roles equivalent).
    const { data: perm } = await admin
      .from('permissions')
      .select('id')
      .eq('key', 'override_visit_sequence')
      .single();
    expect((perm as { id: string }).id).toBe((permRow as { id: string }).id);
    expect((await setGrant(true)).error).toBeNull();

    caller = 'A_ADMIN';
    const ok = await post('Week 2 done at the partner site; records pending');
    expect(ok.status).toBe(201);
    const created = (await ok.json()) as { data: { blocked_by: string[]; authorized_by: string } };
    expect(created.data.blocked_by).toEqual(['Week 2']);
    expect(created.data.authorized_by).toBe(fxId('A_ADMIN'));

    caller = 'A_ADMIN';
    const dup = await post('A second exception for the same visit');
    expect(dup.status).toBe(409);

    const done = await SubjectService.completeVisit(
      subjectId,
      week4.id,
      { scheduled_date: week4.target_date as string },
      ctxFor('A_ADMIN'),
    );
    expect(done.status).toBe('completed');

    const { data: exc } = await admin
      .from('visit_sequence_exceptions')
      .select('consumed_at, consumed_status')
      .eq('visit_id', week4.id);
    expect(exc).toHaveLength(1);
    expect((exc as Array<{ consumed_status: string }>)[0]?.consumed_status).toBe('completed');

    // Reopened and completed again: the exception was consumed → locked again.
    await VisitService.reopenVisit(
      subjectId,
      week4.id,
      { reason: 'Correction needed' },
      ctxFor('A_ADMIN'),
    );
    vs = await visitsOf(subjectId);
    expect(byName(vs, 'Week 4').status).toBe('in_progress');
    await expect(
      SubjectService.completeVisit(
        subjectId,
        week4.id,
        { scheduled_date: week4.target_date as string },
        ctxFor('A_ADMIN'),
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('O-1 through the app: a date outside the window is recorded as out_of_window', async () => {
    const vs = await visitsOf(subjectId);
    const week2 = byName(vs, 'Week 2');
    await startVisit(subjectId, week2.id);
    const late = new Date(`${week2.window_end as string}T00:00:00Z`);
    late.setUTCDate(late.getUTCDate() + 10);
    const result = await SubjectService.completeVisit(
      subjectId,
      week2.id,
      { scheduled_date: late.toISOString().slice(0, 10) },
      ctxFor('A_ADMIN'),
    );
    expect(result.status).toBe('out_of_window');
  });

  it('charts: start → hold → release → start → entered in EDC → reopen through ChartService', async () => {
    const vs = await visitsOf(subjectId);
    const { data: chartRow } = await admin
      .from('charts')
      .select('id, status')
      .eq('visit_id', byName(vs, 'Screening').id)
      .single();
    const chartId = (chartRow as { id: string; status: string }).id;
    expect((chartRow as { status: string }).status).toBe('chart_ready');

    expect((await ChartService.startDataEntry(chartId, ctxFor('A_CRC1'))).status).toBe(
      'in_progress',
    );
    expect((await ChartService.holdChart(chartId, ctxFor('A_CRC1'))).status).toBe('on_hold');
    expect((await ChartService.releaseChart(chartId, ctxFor('A_CRC1'))).status).toBe('chart_ready');
    expect((await ChartService.startDataEntry(chartId, ctxFor('A_CRC1'))).status).toBe(
      'in_progress',
    );
    const entered = await ChartService.markEnteredInEdc(
      chartId,
      { entered_by_role: 'CRC' },
      ctxFor('A_ADMIN'),
    );
    expect(entered.status).toBe('entered_in_edc');
    const reopened = await ChartService.reopenChart(
      chartId,
      { reason: 'EDC query correction' },
      ctxFor('A_ADMIN'),
    );
    expect(reopened.status).toBe('in_progress');
  });

  it('leads: create, normal and exceptional moves; closed-lead behaviour unchanged (Obs-3)', async () => {
    const lead = await LeadService.create({ site_id: A1 }, ctxFor('A_CRC1'));
    expect(lead.status).toBe('new');
    const contacted = await LeadService.changeStatus(
      lead.id,
      { new_status: 'contacted' },
      ctxFor('A_CRC1'),
    );
    expect(contacted.status).toBe('contacted');
    const qualified = await LeadService.changeStatus(
      lead.id,
      { new_status: 'qualified', reason: 'Referred pre-qualified by the PI' },
      ctxFor('A_CRC1'),
    );
    expect(qualified.status).toBe('qualified');
    const lost = await LeadService.changeStatus(
      lead.id,
      { new_status: 'not_qualified' },
      ctxFor('A_CRC1'),
    );
    expect(lost.status).toBe('not_qualified');
    // Application guard (assertNotTerminal) still applies to logContact/waitlist/decline/update.
    await expect(
      LeadService.logContact(lead.id, { new_status: 'contacted' }, ctxFor('A_CRC1')),
    ).rejects.toThrow(BusinessRuleError);
    // Obs-3: changeStatus lets a closed lead move on with a reason; 039 keeps that.
    const reopened = await LeadService.changeStatus(
      lead.id,
      { new_status: 'contacted', reason: 'PI asked to re-contact after a protocol amendment' },
      ctxFor('A_CRC1'),
    );
    expect(reopened.status).toBe('contacted');
  });

  it('studies: close, then archive with subjects (force_archive_study + reason)', async () => {
    const closed = await StudyService.closeStudy(studyId, ctxFor('A_ADMIN'));
    expect(closed.status).toBe('closed');
    await expect(StudyService.activateStudy(studyId, ctxFor('A_ADMIN'))).rejects.toThrow(
      BusinessRuleError,
    );
    const archived = await StudyService.archiveStudy(
      studyId,
      ctxFor('A_ADMIN'),
      'E2 test study retired',
    );
    expect(archived.status).toBe('archived');
  });

  it('a direct Data API write outside the transition map (in_progress -> confirmed) is refused (23514) and nothing changes', async () => {
    const vs = await visitsOf(subjectId);
    const crc = clientFor(proxy.url, 'A_CRC1');
    const r = await crc
      .from('visits')
      .update({ status: 'confirmed' })
      .eq('id', byName(vs, 'Week 4').id);
    expect(r.error?.code).toBe('23514');
    const after = await visitsOf(subjectId);
    expect(byName(after, 'Week 4').status).toBe('in_progress');
    expect(ConflictError).toBeDefined();
  });
});
