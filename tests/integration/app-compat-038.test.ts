// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { POST as commentsPOST } from '@/app/api/charts/[id]/comments/route';
import { PATCH as subjectPATCH } from '@/app/api/subjects/[id]/route';
import {
  rehearsalDbEnabled,
  startProxy,
  clientFor,
  sessionClientFor,
  fxId,
  type ProxyLogEntry,
} from './db/localRehearsalDb';

// G8 M038 — application compatibility against a disposable local database with
// migrations 001–038 (see tests/integration/db/localRehearsalDb.ts). The real
// route handlers, services, PermissionService, AuditService and
// resolveAuthContext run unchanged; only the two client factories are pointed
// at the local PostgREST (session client = the signed-in synthetic user, admin
// client = service_role). Skipped unless the rehearsal environment is set.

const CA = fxId('CA');
const A1 = fxId('A1');
const SA = fxId('SA');
const S_A1 = fxId('S_A1');
const S_A2 = fxId('S_A2');
const CH_A1 = fxId('CH_A1');
const CH_A2 = fxId('CH_A2');
const CH_B1 = fxId('CH_B1');
const MISSING = '0b1e5a3c-1d2f-4a6b-8c7d-9e0f1a2b3c4d';

let proxy: Awaited<ReturnType<typeof startProxy>>;
let admin: SupabaseClient;
let caller = 'A_CRC1';

type Body = {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
};

async function postComment(user: string, chartId: string, comment: string) {
  caller = user;
  const req = new NextRequest(`http://localhost/api/charts/${chartId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ comment }),
    headers: { 'content-type': 'application/json' },
  });
  const res = await commentsPOST(req, { params: Promise.resolve({ id: chartId }) });
  return { status: res.status, text: await res.text() };
}

async function patchSubject(user: string, subjectId: string, body: Record<string, unknown>) {
  caller = user;
  const req = new NextRequest(`http://localhost/api/subjects/${subjectId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  const res = await subjectPATCH(req, { params: Promise.resolve({ id: subjectId }) });
  return { status: res.status, body: (await res.json()) as Body };
}

type StoredComment = {
  id: string;
  company_id: string;
  chart_id: string;
  created_by: string;
  comment: string;
  created_at: string;
};

async function comments(chartId: string): Promise<StoredComment[]> {
  const { data, error } = await admin
    .from('chart_comments')
    .select('id, company_id, chart_id, created_by, comment, created_at')
    .eq('chart_id', chartId);
  expect(error).toBeNull();
  return data as StoredComment[];
}

// Data API writes seen by the proxy since `from` (index into proxy.log).
function writesSince(from: number): string[] {
  return proxy.log
    .slice(from)
    .filter((e) => !['GET', 'HEAD'].includes(e.method))
    .filter((e) => !e.path.startsWith('/rest/v1/rpc/'))
    .map((e) => `${e.method} ${e.path.split('?')[0]} ${e.status}`);
}

// authenticated has no SELECT on audit_logs (036), so audit writes are
// observed at the HTTP layer here; their content is checked in SQL by the
// rehearsal (ev/05_app/audit_rows.txt).
function auditInserts(): number {
  return proxy.log.filter(
    (e) => e.method === 'POST' && e.path.startsWith('/rest/v1/audit_logs') && e.status === 201,
  ).length;
}

async function written(chartId: string, text: string): Promise<number> {
  return (await comments(chartId)).filter((c) => c.comment === text).length;
}

async function subjectRow(id: string) {
  const { data, error } = await admin
    .from('subjects')
    .select('site_id, study_id, company_id, initials')
    .eq('id', id)
    .single();
  expect(error).toBeNull();
  return data as { site_id: string; study_id: string; company_id: string; initials: string | null };
}

function serverErrorsLogged(): number {
  return vi.mocked(logger.error).mock.calls.filter(([msg]) => /failed$/.test(String(msg))).length;
}

describe.skipIf(!rehearsalDbEnabled)(
  'G8 M038 application compatibility (local rehearsal DB)',
  () => {
    const run = Date.now().toString(36);

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
      vi.restoreAllMocks();
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

    describe('POST /api/charts/[id]/comments (rule A)', () => {
      it('same-site commenter (comment_chart + view_charts) → 200, row attributed to the caller, audited', async () => {
        const auditBefore = auditInserts();
        const r = await postComment('A_CRC1', CH_A1, `same-site ${run}`);
        expect(r.status).toBe(200);
        const body = JSON.parse(r.text) as Body;
        expect(body.data?.created_by).toBe(fxId('A_CRC1'));
        const stored = (await comments(CH_A1)).filter((c) => c.id === body.data?.id);
        expect(stored.map((c) => [c.created_by, c.comment])).toEqual([
          [fxId('A_CRC1'), `same-site ${run}`],
        ]);
        expect(auditInserts()).toBe(auditBefore + 1);
      });

      it('response contract (view_charts): exactly the stored row, created_at being the database value', async () => {
        const r = await postComment('A_CRC1', CH_A1, `contract ${run}`);
        expect(r.status).toBe(200);
        const body = JSON.parse(r.text) as Body;
        expect(Object.keys(body).sort()).toEqual(['data', 'message', 'success']);
        const stored = (await comments(CH_A1)).filter((c) => c.comment === `contract ${run}`);
        expect(stored).toHaveLength(1);
        // Same keys and values as the row in the database, created_at included.
        expect(body.data).toEqual(stored[0]);
        expect(typeof body.data?.created_at).toBe('string');
      });

      it('response contract (no view_charts): stored values, created_at null rather than an app-clock value', async () => {
        const r = await postComment('A_CMT', CH_A1, `contract-cmt ${run}`);
        expect(r.status).toBe(200);
        const body = JSON.parse(r.text) as Body;
        const stored = (await comments(CH_A1)).filter((c) => c.comment === `contract-cmt ${run}`);
        expect(stored).toHaveLength(1);
        const { created_at: storedCreatedAt, ...storedRest } = stored[0] as StoredComment;
        expect(body.data).toEqual({ ...storedRest, created_at: null });
        expect(storedCreatedAt).toEqual(expect.any(String));
      });

      it('cross-site chart → 404, nothing written, no audit row', async () => {
        const auditBefore = auditInserts();
        const r = await postComment('A_CRC1', CH_A2, `cross-site ${run}`);
        expect(r.status).toBe(404);
        expect(await written(CH_A2, `cross-site ${run}`)).toBe(0);
        expect(auditInserts()).toBe(auditBefore);
      });

      it('cross-tenant, cross-site and nonexistent charts answer with byte-identical 404 bodies', async () => {
        const crossSite = await postComment('A_CRC1', CH_A2, 'x');
        const crossTenant = await postComment('A_CRC1', CH_B1, 'x');
        const missing = await postComment('A_CRC1', MISSING, 'x');
        expect([crossSite.status, crossTenant.status, missing.status]).toEqual([404, 404, 404]);
        expect(crossSite.text).toBe(missing.text);
        expect(crossTenant.text).toBe(missing.text);
      });

      it('comment_chart WITHOUT view_charts at an accessible site → 200 (R3: independent of view_charts)', async () => {
        const r = await postComment('A_CMT', CH_A1, `commenter-only ${run}`);
        expect(r.status).toBe(200);
        const body = JSON.parse(r.text) as Body;
        expect(body.data?.created_by).toBe(fxId('A_CMT'));
        const stored = (await comments(CH_A1)).filter((c) => c.id === body.data?.id);
        expect(stored.map((c) => c.created_by)).toEqual([fxId('A_CMT')]);
      });

      it('comment_chart WITHOUT view_charts at an inaccessible site → 404, nothing written', async () => {
        const r = await postComment('A_CMT', CH_A2, `cmt-cross ${run}`);
        expect(r.status).toBe(404);
        expect(await written(CH_A2, `cmt-cross ${run}`)).toBe(0);
      });

      it('caller without comment_chart → 403, nothing written', async () => {
        const r = await postComment('A_CLERK', CH_A1, `no-perm ${run}`);
        expect(r.status).toBe(403);
        expect(await written(CH_A1, `no-perm ${run}`)).toBe(0);
      });

      it('refused comments (403, cross-site, cross-tenant, missing) make no Data API write at all', async () => {
        const from = proxy.log.length;
        await postComment('A_CLERK', CH_A1, `nw ${run}`);
        await postComment('A_CRC1', CH_A2, `nw ${run}`);
        await postComment('A_CRC1', CH_B1, `nw ${run}`);
        await postComment('A_CRC1', MISSING, `nw ${run}`);
        await postComment('A_CMT', CH_A2, `nw ${run}`);
        expect(writesSince(from)).toEqual([]);
        // ...and the privileged client is not even used to look an unauthorized chart up.
        expect(proxy.log.slice(from).filter((e) => e.role === 'service_role')).toEqual([]);
      });

      it('a chart that vanishes after authorization (FK/RLS race) → 404, nothing written, no audit, no 500', async () => {
        // The app's checks pass for a chart id that does not exist (simulated
        // stale answer); the database is the last line: chart_comments_insert
        // (038 can_access_chart) or the chart FK refuses the row.
        vi.mocked(createServerSupabaseClient).mockImplementation(async () => {
          const c = sessionClientFor(proxy.url, caller);
          const rpc = c.rpc.bind(c);
          c.rpc = ((fn: string, args?: Record<string, unknown>) =>
            fn === 'can_access_chart'
              ? Promise.resolve({ data: true, error: null })
              : rpc(fn, args)) as unknown as typeof c.rpc;
          return c as never;
        });
        vi.mocked(createAdminSupabaseClient).mockImplementation(() => {
          const real = clientFor(proxy.url, 'service_role');
          return {
            from: (table: string) =>
              table === 'charts'
                ? {
                    select: () => ({
                      eq: () => ({
                        eq: () => ({
                          single: async () => ({
                            data: { id: MISSING, company_id: CA, site_id: A1 },
                            error: null,
                          }),
                        }),
                      }),
                    }),
                  }
                : real.from(table),
          } as never;
        });
        const auditBefore = auditInserts();
        const errorsBefore = serverErrorsLogged();
        const r = await postComment('A_CRC1', MISSING, `vanished ${run}`);
        expect(r.status).toBe(404);
        expect(await written(MISSING, `vanished ${run}`)).toBe(0);
        expect(auditInserts()).toBe(auditBefore);
        expect(serverErrorsLogged()).toBe(errorsBefore);
      });

      it('view_all_sites + comment_chart, other own-company site → 200', async () => {
        const r = await postComment('A_ADMIN', CH_A2, `admin ${run}`);
        expect(r.status).toBe(200);
      });

      it('a real DB refusal (038 can_access_chart → 42501) past the app check maps to 404, not 500', async () => {
        // Simulates a race / stale app check: the app believes the chart is
        // accessible, the database (038) refuses the insert.
        vi.mocked(createServerSupabaseClient).mockImplementation(async () => {
          const c = sessionClientFor(proxy.url, caller);
          const rpc = c.rpc.bind(c);
          c.rpc = ((fn: string, args?: Record<string, unknown>) =>
            fn === 'can_access_chart'
              ? Promise.resolve({ data: true, error: null })
              : rpc(fn, args)) as unknown as typeof c.rpc;
          return c as never;
        });
        const errorsBefore = serverErrorsLogged();
        const r = await postComment('A_CRC1', CH_A2, `raced ${run}`);
        expect(r.status).toBe(404);
        expect(await written(CH_A2, `raced ${run}`)).toBe(0);
        expect(serverErrorsLogged()).toBe(errorsBefore);
        const refused = proxy.log.filter(
          (e) =>
            e.method === 'POST' && e.path.startsWith('/rest/v1/chart_comments') && e.status === 403,
        );
        expect(refused.length).toBeGreaterThan(0);
      });
    });

    describe('PATCH /api/subjects/[id] (rule B)', () => {
      it('site/study/company keys in the payload are stripped; valid fields update; scope unchanged', async () => {
        const before = await subjectRow(S_A1);
        const r = await patchSubject('A_CRC1', S_A1, {
          initials: `Q${run.slice(-4)}`,
          site_id: fxId('A2'),
          study_id: fxId('SA2'),
          company_id: fxId('CB'),
        });
        expect(r.status).toBe(200);
        const after = await subjectRow(S_A1);
        expect(after.initials).toBe(`Q${run.slice(-4)}`);
        expect([after.site_id, after.study_id, after.company_id]).toEqual([
          before.site_id,
          before.study_id,
          before.company_id,
        ]);
        expect([after.site_id, after.study_id, after.company_id]).toEqual([A1, SA, CA]);
      });

      it('subject at another site → 404, no change', async () => {
        const before = await subjectRow(S_A2);
        const r = await patchSubject('A_CRC1', S_A2, { initials: 'NO' });
        expect(r.status).toBe(404);
        expect(await subjectRow(S_A2)).toEqual(before);
      });

      it.each([
        ['an empty payload', {}],
        ['only site_id', { site_id: fxId('A2') }],
        ['only study_id', { study_id: fxId('SA2') }],
        ['only company_id', { company_id: fxId('CB') }],
        [
          'site_id, study_id and company_id',
          { site_id: fxId('A2'), study_id: fxId('SA2'), company_id: fxId('CB') },
        ],
      ])(
        '%s → 400, no service call, no write, no audit, subject unchanged',
        async (_name, payload) => {
          const before = await subjectRow(S_A1);
          const from = proxy.log.length;
          const r = await patchSubject('A_ADMIN', S_A1, payload);
          expect(r.status).toBe(400);
          expect(r.body.error?.code).toBe('VALIDATION_ERROR');
          // Only authentication traffic: SubjectService was never reached.
          expect(
            proxy.log
              .slice(from)
              .map((e) => `${e.method} ${e.path.split('?')[0]}`)
              .filter((p) => !p.startsWith('GET /auth/v1/user') && p !== 'GET /rest/v1/profiles'),
          ).toEqual([]);
          expect(writesSince(from)).toEqual([]);
          expect(await subjectRow(S_A1)).toEqual(before);
        },
      );

      it('an invalid allowed field (even beside a valid one) → 400, no partial write', async () => {
        const before = await subjectRow(S_A1);
        const from = proxy.log.length;
        const r = await patchSubject('A_ADMIN', S_A1, {
          initials: 'OK',
          screening_date: 'not-a-date',
        });
        expect(r.status).toBe(400);
        expect(writesSince(from)).toEqual([]);
        expect(await subjectRow(S_A1)).toEqual(before);
      });

      it('a valid update still works and is audited once', async () => {
        const auditBefore = auditInserts();
        const initials = `V${run.slice(-4)}`;
        const r = await patchSubject('A_ADMIN', S_A1, { initials });
        expect(r.status).toBe(200);
        expect(r.body.data?.initials).toBe(initials);
        expect((await subjectRow(S_A1)).initials).toBe(initials);
        expect(auditInserts()).toBe(auditBefore + 1);
      });

      it('cross-tenant subject → 404, no change', async () => {
        const S_B1 = fxId('S_B1');
        const { data: before } = await clientFor(proxy.url, 'B_ADMIN')
          .from('subjects')
          .select('initials, site_id, study_id, company_id')
          .eq('id', S_B1)
          .single();
        expect(before).toMatchObject({ company_id: fxId('CB') });
        const from = proxy.log.length;
        const r = await patchSubject('A_ADMIN', S_B1, { initials: 'XT' });
        expect(r.status).toBe(404);
        expect(writesSince(from)).toEqual([]);
        const { data: after } = await clientFor(proxy.url, 'B_ADMIN')
          .from('subjects')
          .select('initials, site_id, study_id, company_id')
          .eq('id', S_B1)
          .single();
        expect(after).toEqual(before);
      });

      it('caller without edit_subject → 403, no write', async () => {
        const before = await subjectRow(S_A1);
        const from = proxy.log.length;
        const r = await patchSubject('A_CLERK', S_A1, { initials: 'NP' });
        expect(r.status).toBe(403);
        expect(writesSince(from)).toEqual([]);
        expect(await subjectRow(S_A1)).toEqual(before);
      });
    });

    describe('privileged client use', () => {
      it('the service_role (admin) client only ever read; every write went through the session client under RLS', () => {
        const adminCalls = proxy.log.filter((e: ProxyLogEntry) => e.role === 'service_role');
        expect(adminCalls.length).toBeGreaterThan(0);
        expect(adminCalls.filter((e) => e.method !== 'GET' && e.method !== 'HEAD')).toEqual([]);
        const writes = proxy.log.filter(
          (e) => !['GET', 'HEAD'].includes(e.method) && e.path.startsWith('/rest/v1/'),
        );
        expect(writes.every((e) => e.role === 'authenticated')).toBe(true);
      });

      it('records 404 latency for inaccessible vs nonexistent charts (informational; owner residual)', async () => {
        const sample = async (chartId: string) => {
          const t: number[] = [];
          for (let i = 0; i < 25; i++) {
            const s = performance.now();
            await postComment('A_CRC1', chartId, 'timing');
            t.push(performance.now() - s);
          }
          t.sort((a, b) => a - b);
          const at = (i: number) => Number((t[i] ?? Number.NaN).toFixed(2));
          return { median_ms: at(12), p10_ms: at(2), p90_ms: at(22) };
        };
        const inaccessible = await sample(CH_A2);
        const nonexistent = await sample(MISSING);
        const dir = process.env.ZQ_REHEARSAL_EVIDENCE_DIR;
        if (dir) {
          fs.writeFileSync(
            path.join(dir, 'comment_404_timing.json'),
            JSON.stringify({ inaccessible, nonexistent, samples: 25 }, null, 2),
          );
        }
        expect(inaccessible.median_ms).toBeGreaterThan(0);
      });
    });
  },
);
