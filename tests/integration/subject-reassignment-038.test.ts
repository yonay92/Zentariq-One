// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { rehearsalDbEnabled, startProxy, clientFor, fxId } from './db/localRehearsalDb';

// G8 M038 — database-level checks of owner rules A and B through the Data API
// (supabase-js → PostgREST), exactly as a signed-in user could call it
// directly. They need a disposable local database with migrations 001–038 and
// the synthetic G8 fixtures (see tests/integration/db/localRehearsalDb.ts), so
// they are skipped unless ZQ_REHEARSAL_PGRST_URL / ZQ_REHEARSAL_JWT_SECRET
// point at one. Every refused write is followed by a read proving nothing
// changed. Each case works on its own rows, so files can run in parallel.

const CA = fxId('CA');
const A1 = fxId('A1');
const A2 = fxId('A2');
const B1 = fxId('B1');
const SA = fxId('SA');
const SA2 = fxId('SA2');
const SB = fxId('SB');
const CH_A1 = fxId('CH_A1');
const CH_A2 = fxId('CH_A2');

let proxy: Awaited<ReturnType<typeof startProxy>>;
let admin: SupabaseClient;
const run = Date.now().toString(36);

type SubjectScope = {
  site_id: string;
  study_id: string;
  company_id: string;
  initials: string | null;
  created_by: string | null;
  created_at: string;
};

async function subjectRow(id: string): Promise<SubjectScope> {
  const { data, error } = await admin
    .from('subjects')
    .select('site_id, study_id, company_id, initials, created_by, created_at')
    .eq('id', id)
    .single();
  expect(error).toBeNull();
  return data as SubjectScope;
}

async function written(chartId: string, text: string): Promise<number> {
  const { count, error } = await admin
    .from('chart_comments')
    .select('id', { count: 'exact', head: true })
    .eq('chart_id', chartId)
    .eq('comment', text);
  expect(error).toBeNull();
  return count ?? -1;
}

async function newSubject(label: string): Promise<string> {
  const { data, error } = await admin
    .from('subjects')
    .insert({ company_id: CA, site_id: A1, study_id: SA, subject_number: `R-${label}-${run}` })
    .select('id')
    .single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

/** A fresh tenant A subject at site A1 / study A with one visit. */
async function newSubjectWithVisit(label: string): Promise<string> {
  const id = await newSubject(label);
  const v = await admin
    .from('visits')
    .insert({ company_id: CA, site_id: A1, study_id: SA, subject_id: id, visit_name: 'Screening' });
  expect(v.error).toBeNull();
  return id;
}

describe.skipIf(!rehearsalDbEnabled)(
  'G8 M038 rules A/B at the database layer (local rehearsal DB)',
  () => {
    beforeAll(async () => {
      proxy = await startProxy();
      admin = clientFor(proxy.url, 'A_ADMIN');
    });
    afterAll(async () => {
      await proxy?.close();
    });

    describe('Rule B: subject site/study reassignment after visits exist', () => {
      it('B3 same-tenant site_id change on a subject with visits → 23503 (409), row unchanged', async () => {
        const subject = await newSubjectWithVisit('b3');
        const before = await subjectRow(subject);
        const r = await admin.from('subjects').update({ site_id: A2 }).eq('id', subject);
        expect(r.error?.code).toBe('23503');
        expect(r.status).toBe(409);
        expect(await subjectRow(subject)).toEqual(before);
      });

      it('B4 same-tenant study_id change on a subject with visits → 23503 (409), row unchanged', async () => {
        const subject = await newSubjectWithVisit('b4');
        const before = await subjectRow(subject);
        const r = await admin.from('subjects').update({ study_id: SA2 }).eq('id', subject);
        expect(r.error?.code).toBe('23503');
        expect(r.status).toBe(409);
        expect(await subjectRow(subject)).toEqual(before);
      });

      it('B5 site_id change on a subject with subject_contact_info but no visits → 23503', async () => {
        const subject = await newSubject('b5');
        const ins = await admin.from('subject_contact_info').insert({
          company_id: CA,
          site_id: A1,
          subject_id: subject,
          first_name: 'Syn',
          last_name: 'Thetic',
          date_of_birth: '1980-01-01',
          sex: 'other',
          phone_primary: '000',
          preferred_language: 'en',
        });
        expect(ins.error).toBeNull();
        const r = await admin.from('subjects').update({ site_id: A2 }).eq('id', subject);
        expect(r.error?.code).toBe('23503');
        expect((await subjectRow(subject)).site_id).toBe(A1);
      });

      it('B6 site/study change on a subject with no visits and no contact info → allowed (accepted residual)', async () => {
        const subject = await newSubject('b6');
        const r = await admin
          .from('subjects')
          .update({ site_id: A2, study_id: SA2 })
          .eq('id', subject);
        expect(r.error).toBeNull();
        const row = await subjectRow(subject);
        expect([row.site_id, row.study_id]).toEqual([A2, SA2]);
      });

      it('B7 site_id / study_id set to tenant B values → refused, no partial change', async () => {
        const subject = await newSubjectWithVisit('b7');
        const before = await subjectRow(subject);
        const withVisits = await admin
          .from('subjects')
          .update({ initials: 'ZZ', site_id: B1, study_id: SB })
          .eq('id', subject);
        expect(withVisits.error).not.toBeNull();
        expect(await subjectRow(subject)).toEqual(before);

        const noVisits = await newSubject('b7n');
        const r = await admin.from('subjects').update({ study_id: SB }).eq('id', noVisits);
        expect(r.error?.code).toBe('23503');
        expect((await subjectRow(noVisits)).study_id).toBe(SA);
      });

      it('B8 initials / screening_date / end_of_study_date update on a subject with visits → allowed; created_by/created_at unchanged', async () => {
        const subject = await newSubjectWithVisit('b8');
        const before = await subjectRow(subject);
        const r = await clientFor(proxy.url, 'A_CRC1')
          .from('subjects')
          .update({ initials: 'B8', screening_date: '2026-01-15', end_of_study_date: null })
          .eq('id', subject);
        expect(r.error).toBeNull();
        expect(await subjectRow(subject)).toEqual({ ...before, initials: 'B8' });
      });

      it('B10 service_role site change on a subject with visits → refused (no UPDATE grant, 036); row unchanged', async () => {
        // The composite FK also binds the table owner (harness case B10b); over
        // the Data API service_role is stopped earlier by its missing grant.
        const subject = await newSubjectWithVisit('b10');
        const before = await subjectRow(subject);
        const r = await clientFor(proxy.url, 'service_role')
          .from('subjects')
          .update({ site_id: A2 })
          .eq('id', subject);
        expect(r.error?.code).toBe('42501');
        expect(await subjectRow(subject)).toEqual(before);
      });
    });

    describe('Rule A: chart comments at the database layer', () => {
      it('EXT-S4 comment_chart holder inserting a comment on a chart at an inaccessible site → 42501, nothing written', async () => {
        const r = await clientFor(proxy.url, 'A_CRC1')
          .from('chart_comments')
          .insert({ company_id: CA, chart_id: CH_A2, comment: `s4 ${run}` });
        expect(r.error?.code).toBe('42501');
        expect(await written(CH_A2, `s4 ${run}`)).toBe(0);
      });

      it('LX-13 same-site commenter → insert allowed, created_by = caller', async () => {
        const r = await clientFor(proxy.url, 'A_CRC1')
          .from('chart_comments')
          .insert({ company_id: CA, chart_id: CH_A1, comment: `lx13 ${run}` })
          .select('created_by')
          .single();
        expect(r.error).toBeNull();
        expect((r.data as { created_by: string }).created_by).toBe(fxId('A_CRC1'));
      });

      it('LX-13b comment_chart without view_charts at an accessible site → insert allowed (R3 at DB level)', async () => {
        const r = await clientFor(proxy.url, 'A_CMT')
          .from('chart_comments')
          .insert({
            company_id: CA,
            chart_id: CH_A1,
            comment: `lx13b ${run}`,
            created_by: fxId('A_CMT'),
          });
        expect(r.error).toBeNull();
        expect(r.status).toBe(201);
        expect(await written(CH_A1, `lx13b ${run}`)).toBe(1);
      });

      it('EXT-S4b view_all_sites + comment_chart, any own-company site → insert allowed', async () => {
        const r = await admin
          .from('chart_comments')
          .insert({ company_id: CA, chart_id: CH_A2, comment: `s4b ${run}` });
        expect(r.error).toBeNull();
        expect(await written(CH_A2, `s4b ${run}`)).toBe(1);
      });
    });
  },
);
