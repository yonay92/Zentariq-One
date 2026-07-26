import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { RequirementBuilderPanel } from '@/components/regulatory/RequirementBuilderPanel';
import type { DocumentType, RegulatoryDocumentRequirement } from '@/types/regulatory';

const DOCUMENT_TYPE: DocumentType = {
  id: 'type-1',
  company_id: 'company-1',
  name: '1572 Form',
  category: 'Essential Documents',
  has_expiration: false,
  expiration_rule: null,
  default_alert_days: [90, 60, 30, 14, 7],
  requires_version: true,
  required_by_default: false,
  created_at: '',
  updated_at: '',
};

const PERSISTED_REQUIREMENT: RegulatoryDocumentRequirement = {
  id: 'req-1',
  company_id: 'company-1',
  study_id: 'study-1',
  site_id: null,
  document_type_id: 'type-1',
  required: true,
  expiration_required: false,
  applies_to: null,
  created_at: '',
};

function checkboxState(el: HTMLElement) {
  const input = el as HTMLInputElement;
  return { checked: input.checked, disabled: input.disabled };
}

// Mirrors the real parent (StudyRegulatoryPage): onChanged is the awaited
// refetch — it only updates the `requirements` prop once it resolves, same
// as the real fetchAll(). The `deferred` control lets the test decide
// exactly when that refetch "completes" so the checkbox's disabled/checked
// state can be inspected mid-flight.
function Harness({ deferred }: { deferred: { promise: Promise<void>; resolve: () => void } }) {
  const [requirements, setRequirements] = useState<RegulatoryDocumentRequirement[]>([]);

  async function onChanged() {
    await deferred.promise;
    setRequirements([PERSISTED_REQUIREMENT]);
  }

  return (
    <RequirementBuilderPanel
      open
      onClose={() => {}}
      onChanged={onChanged}
      scope={{ studyId: 'study-1' }}
      documentTypes={[DOCUMENT_TYPE]}
      requirements={requirements}
      loading={false}
    />
  );
}

function makeDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: PERSISTED_REQUIREMENT }),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RequirementBuilderPanel — awaited refetch', () => {
  it('keeps the checkbox disabled until the refetch (onChanged) resolves, not just the write', async () => {
    const deferred = makeDeferred();
    render(<Harness deferred={deferred} />);

    const checkbox = screen.getByLabelText('Required for 1572 Form');
    expect(checkboxState(checkbox).checked).toBe(false);

    fireEvent.click(checkbox);

    // The POST itself resolves (mocked fetch), but onChanged()'s promise is
    // still pending — the checkbox must stay disabled and still unchecked.
    await waitFor(() => expect(checkboxState(checkbox).disabled).toBe(true));
    expect(checkboxState(checkbox).checked).toBe(false);

    // Give any stray microtasks a chance to run — if the old (buggy) code
    // were still in place, setBusyTypeId(null) would already have fired by
    // now, re-enabling the checkbox even though `deferred` hasn't resolved.
    await new Promise((r) => setTimeout(r, 50));
    expect(checkboxState(checkbox).disabled).toBe(true);
    expect(checkboxState(checkbox).checked).toBe(false);
  });

  it('reflects the persisted value at the exact moment it re-enables — never enabled-but-stale', async () => {
    const deferred = makeDeferred();
    render(<Harness deferred={deferred} />);

    const checkbox = screen.getByLabelText('Required for 1572 Form');
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkboxState(checkbox).disabled).toBe(true));

    // Resolve the refetch — Harness's onChanged() then applies the new
    // requirements state (mirroring the real page's setRequirements call).
    deferred.resolve();

    await waitFor(() => expect(checkboxState(checkbox).disabled).toBe(false));
    // The instant it re-enables, it must already show the persisted value —
    // not a stale unchecked state that catches up a moment later.
    expect(checkboxState(checkbox).checked).toBe(true);
  });
});
