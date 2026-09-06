import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ChartDetailView } from '@/components/charts/ChartDetailView';
import type { Chart, ChartStatus } from '@/types/charts';

function renderPage(chartId: string) {
  return render(<ChartDetailView chartId={chartId} />);
}

const COMPANY_ID = 'company-1';
const SITE_ID = 'site-1';
const STUDY_ID = 'study-1';
const SUBJECT_ID = 'subject-1';
const VISIT_ID = 'visit-1';
const CHART_ID = 'chart-1';

function makeChart(overrides: Partial<Chart> = {}): Chart {
  return {
    id: CHART_ID,
    company_id: COMPANY_ID,
    site_id: SITE_ID,
    study_id: STUDY_ID,
    subject_id: SUBJECT_ID,
    visit_id: VISIT_ID,
    chart_ready_date: '2026-01-01T00:00:00Z',
    entered_in_edc_date: null,
    entered_by: null,
    entered_by_role: null,
    days_until_entry: null,
    priority: 'low',
    status: 'chart_ready',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockFetchFor(options: { status: ChartStatus; permissions?: string[] }) {
  const chart = makeChart({ status: options.status });
  const permissions = options.permissions ?? [];

  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (data: unknown) =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ data }) } as Response);

    if (url === '/api/users/me/permissions') return json({ permissions });
    if (url === `/api/charts/${CHART_ID}`) return json(chart);
    if (url === `/api/charts/${CHART_ID}/history`) return json([]);
    if (url === `/api/subjects/${SUBJECT_ID}`) return json({ subject_number: '001-001' });
    if (url === `/api/studies/${STUDY_ID}`) return json({ study_name: 'ACME-01' });
    if (url === `/api/sites/${SITE_ID}`) return json({ name: 'Main Site' });
    if (url === `/api/visits/${VISIT_ID}`)
      return json({
        id: VISIT_ID,
        visit_name: 'Week 8',
        scheduled_date: '2026-01-01',
        target_date: '2026-01-01',
        status: 'completed',
      });

    return Promise.resolve({ ok: false, json: () => Promise.resolve({ data: null }) } as Response);
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChartDetailPage — status-gated actions', () => {
  it('shows Start Data Entry and Hold for a chart_ready chart when the caller has mark_chart_ready', async () => {
    global.fetch = mockFetchFor({ status: 'chart_ready', permissions: ['mark_chart_ready'] });
    renderPage(CHART_ID);

    expect(await screen.findByRole('button', { name: 'Start Data Entry' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hold' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark Entered in EDC' })).toBeNull();
  });

  it('hides every action for a chart_ready chart when the caller lacks mark_chart_ready', async () => {
    global.fetch = mockFetchFor({ status: 'chart_ready', permissions: [] });
    renderPage(CHART_ID);

    expect(await screen.findByText('No actions available for this chart.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start Data Entry' })).toBeNull();
  });

  it('shows Mark Entered in EDC for an in_progress chart when the caller has mark_chart_entered', async () => {
    global.fetch = mockFetchFor({ status: 'in_progress', permissions: ['mark_chart_entered'] });
    renderPage(CHART_ID);

    expect(await screen.findByRole('button', { name: 'Mark Entered in EDC' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start Data Entry' })).toBeNull();
  });

  it('shows Release for an on_hold chart when the caller has mark_chart_ready', async () => {
    global.fetch = mockFetchFor({ status: 'on_hold', permissions: ['mark_chart_ready'] });
    renderPage(CHART_ID);

    expect(await screen.findByRole('button', { name: 'Release' })).toBeTruthy();
  });

  it('does not show Reopen for an entered_in_edc chart when the caller lacks reopen_chart', async () => {
    global.fetch = mockFetchFor({ status: 'entered_in_edc', permissions: [] });
    renderPage(CHART_ID);

    await waitFor(() =>
      expect(screen.getByText('No actions available for this chart.')).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
  });

  it('shows Reopen for an entered_in_edc chart when the caller has reopen_chart', async () => {
    global.fetch = mockFetchFor({ status: 'entered_in_edc', permissions: ['reopen_chart'] });
    renderPage(CHART_ID);

    expect(await screen.findByRole('button', { name: 'Reopen' })).toBeTruthy();
  });

  it('shows the immutability banner for an entered_in_edc chart', async () => {
    global.fetch = mockFetchFor({ status: 'entered_in_edc', permissions: [] });
    renderPage(CHART_ID);

    expect(await screen.findByText(/This chart is Entered in EDC and is locked/)).toBeTruthy();
  });
});

describe('ChartDetailPage — not found', () => {
  it('shows a not-found state when the chart request fails (e.g. cross-company access)', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({ data: null }) } as Response),
    );
    renderPage(CHART_ID);

    expect(await screen.findByText('Chart not found')).toBeTruthy();
  });
});
