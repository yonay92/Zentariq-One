import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { StudyRegulatoryPageContent } from '@/components/regulatory/StudyRegulatoryPageContent';
import type { RegulatoryDocumentRequirement } from '@/types/regulatory';

const STUDY_ID = 'study-1';

const REQUIREMENT: RegulatoryDocumentRequirement = {
  id: 'req-1',
  company_id: 'company-1',
  study_id: STUDY_ID,
  site_id: null,
  document_type_id: 'type-1',
  required: true,
  expiration_required: false,
  applies_to: null,
  created_at: '',
};

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ data }) } as Response);
}

function jsonFail(status = 500) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({ success: false, error: { message: 'failed' } }),
  } as Response);
}

function renderPage() {
  return render(<StudyRegulatoryPageContent studyId={STUDY_ID} />);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StudyRegulatoryPage — fetchAll independence', () => {
  it('a binder-fetch failure does not suppress the requirements refetch or falsely show a requirements error', async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === `/api/studies/${STUDY_ID}/regulatory`) return jsonFail();
      if (url === `/api/studies/${STUDY_ID}`) return jsonOk({ study_name: 'ACME-01' });
      if (url === `/api/regulatory/requirements?study_id=${STUDY_ID}`) {
        return jsonOk([REQUIREMENT]);
      }
      if (url === '/api/regulatory/document-types') return jsonOk([]);
      if (url === '/api/users/me/permissions') return jsonOk({ permissions: [] });
      return jsonFail(404);
    });

    renderPage();

    // The binder itself failed, so the generic binder error must appear...
    await waitFor(() =>
      expect(
        screen.queryByText('Failed to load the regulatory binder. Please refresh.'),
      ).toBeTruthy(),
    );
    // ...but the requirements-specific error must NOT appear — proving the
    // binder failure did not cascade into (or suppress the outcome of) the
    // independently-successful requirements fetch. Before the fix, a single
    // shared try/catch threw on the binder failure and skipped
    // setRequirements() entirely, indistinguishable from a real requirements
    // failure.
    expect(
      screen.queryByText('Failed to load document requirements. Please try again.'),
    ).toBeNull();
  });

  it('a requirements-fetch failure surfaces its own visible error and does not falsely show success', async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === `/api/studies/${STUDY_ID}/regulatory`) {
        return jsonOk({
          documents: [],
          health: {
            scope: 'study',
            scope_id: STUDY_ID,
            score: null,
            numerator: 0,
            denominator: 0,
            breakdown: {
              current: 0,
              expiring_soon: 0,
              expired: 0,
              missing: 0,
              pending_review: 0,
              rejected: 0,
            },
          },
        });
      }
      if (url === `/api/studies/${STUDY_ID}`) return jsonOk({ study_name: 'ACME-01' });
      if (url === `/api/regulatory/requirements?study_id=${STUDY_ID}`) return jsonFail();
      if (url === '/api/regulatory/document-types') return jsonOk([]);
      if (url === '/api/users/me/permissions') return jsonOk({ permissions: [] });
      return jsonFail(404);
    });

    renderPage();

    await waitFor(() =>
      expect(
        screen.queryByText('Failed to load document requirements. Please try again.'),
      ).toBeTruthy(),
    );
    // No false success: the generic binder error (which did succeed) must
    // not also appear, and the binder itself should still render since its
    // own fetch succeeded — a requirements failure is scoped to requirements.
    expect(screen.queryByText('Failed to load the regulatory binder. Please refresh.')).toBeNull();
  });
});
