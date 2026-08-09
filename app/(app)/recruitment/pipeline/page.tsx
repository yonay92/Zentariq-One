'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useDroppable } from '@dnd-kit/core';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { RecruitmentViewTabs } from '@/components/recruitment/RecruitmentViewTabs';
import { LeadPipelineCard } from '@/components/recruitment/LeadPipelineCard';
import { useRecruitmentFilters } from '@/hooks/useRecruitmentFilters';
import {
  PIPELINE_COLUMN_ORDER,
  PIPELINE_COLUMN_LABELS,
  PIPELINE_COLUMN_STATUSES,
} from '@/lib/utils/leadPipelineColumns';
import type {
  LeadListItem,
  LeadPriority,
  LeadStatus,
  PipelineColumnKey,
  PipelineCounts,
} from '@/types/recruitment';
import type { Study } from '@/types/studies';
import type { Site } from '@/types/sites';
import type { Profile } from '@/types/users';

const PRIORITY_OPTIONS: Array<{ value: LeadPriority; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

const CARDS_PAGE_SIZE = 10;

type ColumnState = { cards: LeadListItem[]; page: number; hasMore: boolean; loading: boolean };

function emptyColumnState(): ColumnState {
  return { cards: [], page: 0, hasMore: false, loading: false };
}

function PipelineColumnDroppable({
  column,
  count,
  state,
  users,
  onLoadMore,
  onOpenMoveMenu,
}: {
  column: PipelineColumnKey;
  count: number;
  state: ColumnState;
  users: Profile[];
  onLoadMore: () => void;
  onOpenMoveMenu: (lead: LeadListItem) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column });

  const userName = (id: string | null) => users.find((u) => u.id === id)?.full_name ?? null;

  return (
    <div
      ref={setNodeRef}
      className={`flex w-72 shrink-0 flex-col rounded-xl border bg-gray-50 ${
        isOver ? 'border-blue-400 bg-blue-50' : 'border-gray-200'
      }`}
    >
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
        <h3 className="text-sm font-semibold text-gray-900">{PIPELINE_COLUMN_LABELS[column]}</h3>
        <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
          {count}
        </span>
      </div>
      <div
        className="min-h-[4rem] flex-1 space-y-2 overflow-y-auto p-2"
        style={{ maxHeight: '70vh' }}
      >
        {state.cards.map((lead) => (
          <LeadPipelineCard
            key={lead.id}
            lead={lead}
            assignedUserName={userName(lead.assigned_user_id)}
            onOpenMoveMenu={() => onOpenMoveMenu(lead)}
          />
        ))}
        {state.cards.length === 0 && !state.loading && (
          <p className="px-1 py-2 text-center text-xs text-gray-400">No leads</p>
        )}
        {state.loading && (
          <div className="flex justify-center py-2">
            <LoadingSpinner size="sm" />
          </div>
        )}
        {state.hasMore && !state.loading && (
          <button
            type="button"
            onClick={onLoadMore}
            className="w-full rounded-md py-1 text-xs font-medium text-blue-600 hover:bg-blue-50"
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
}

function RecruitmentPipelineContent() {
  const { get, setMany } = useRecruitmentFilters();

  const [sites, setSites] = useState<Site[]>([]);
  const [studies, setStudies] = useState<Study[]>([]);
  const [users, setUsers] = useState<Profile[]>([]);

  const [counts, setCounts] = useState<PipelineCounts | null>(null);
  const [columns, setColumns] = useState<Record<PipelineColumnKey, ColumnState>>(
    () =>
      Object.fromEntries(PIPELINE_COLUMN_ORDER.map((c) => [c, emptyColumnState()])) as Record<
        PipelineColumnKey,
        ColumnState
      >,
  );
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const [moveMenuLead, setMoveMenuLead] = useState<LeadListItem | null>(null);
  const [moveOptions, setMoveOptions] = useState<LeadStatus[]>([]);
  const [moveLoading, setMoveLoading] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    void (async () => {
      const [sitesRes, studiesRes, usersRes] = await Promise.all([
        fetch('/api/sites'),
        fetch('/api/studies'),
        fetch('/api/users'),
      ]);
      if (sitesRes.ok) setSites(((await sitesRes.json()) as { data: Site[] }).data);
      if (studiesRes.ok) setStudies(((await studiesRes.json()) as { data: Study[] }).data);
      if (usersRes.ok) setUsers(((await usersRes.json()) as { data: Profile[] }).data);
    })();
  }, []);

  const boardFilterParams = useCallback(() => {
    const params = new URLSearchParams();
    for (const key of ['site_id', 'study_id', 'assigned_user_id', 'priority']) {
      const value = get(key);
      if (value) params.set(key, value);
    }
    return params;
  }, [get]);

  const fetchColumnCards = useCallback(
    async (column: PipelineColumnKey, page: number) => {
      setColumns((prev) => ({ ...prev, [column]: { ...prev[column], loading: true } }));
      const params = boardFilterParams();
      for (const status of PIPELINE_COLUMN_STATUSES[column]) {
        params.append('statuses', status);
      }
      params.set('page', String(page));
      params.set('page_size', String(CARDS_PAGE_SIZE));
      params.set('sort_by', 'created_at');
      params.set('sort_dir', 'desc');

      const res = await fetch(`/api/leads?${params.toString()}`);
      if (!res.ok) {
        setColumns((prev) => ({ ...prev, [column]: { ...prev[column], loading: false } }));
        return;
      }
      const json = (await res.json()) as { data: { data: LeadListItem[]; total: number } };
      setColumns((prev) => {
        const existing = page === 1 ? [] : prev[column].cards;
        const combined = [...existing, ...json.data.data];
        return {
          ...prev,
          [column]: {
            cards: combined,
            page,
            hasMore: combined.length < json.data.total,
            loading: false,
          },
        };
      });
    },
    [boardFilterParams],
  );

  const fetchBoard = useCallback(async () => {
    setError(null);
    try {
      const countParams = boardFilterParams();
      const countsRes = await fetch(`/api/leads/pipeline-counts?${countParams.toString()}`);
      if (!countsRes.ok) throw new Error('Failed to load pipeline counts');
      const countsJson = (await countsRes.json()) as { data: PipelineCounts };
      setCounts(countsJson.data);

      // Only columns with at least one lead are fetched — never the whole
      // dataset, and empty columns skip a wasted round trip entirely.
      const nonEmptyColumns = countsJson.data.columns
        .filter((c) => c.count > 0)
        .map((c) => c.column);
      setColumns(
        Object.fromEntries(PIPELINE_COLUMN_ORDER.map((c) => [c, emptyColumnState()])) as Record<
          PipelineColumnKey,
          ColumnState
        >,
      );
      await Promise.all(nonEmptyColumns.map((c) => fetchColumnCards(c, 1)));
    } catch {
      setError('Failed to load the pipeline. Please try again.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardFilterParams]);

  useEffect(() => {
    void fetchBoard();
  }, [fetchBoard]);

  async function applyStatusChange(leadId: string, newStatus: LeadStatus): Promise<string | null> {
    const res = await fetch(`/api/leads/${leadId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_status: newStatus }),
    });
    const json = (await res.json()) as { success: boolean; error?: { message: string } };
    if (!res.ok || !json.success) {
      return json.error?.message ?? 'Failed to change status';
    }
    return null;
  }

  // Optimistic move, with a reliable rollback: the previous board state is
  // captured before mutating, and restored verbatim if the backend rejects
  // the transition — the backend's exact message is what's shown, never a
  // client-guessed one.
  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const targetColumn = over.id as PipelineColumnKey;
    let draggedLead: LeadListItem | null = null;
    let sourceColumn: PipelineColumnKey | null = null;
    for (const column of PIPELINE_COLUMN_ORDER) {
      const found = columns[column].cards.find((c) => c.id === active.id);
      if (found) {
        draggedLead = found;
        sourceColumn = column;
        break;
      }
    }
    if (!draggedLead || !sourceColumn || sourceColumn === targetColumn) return;

    const targetStatus = PIPELINE_COLUMN_STATUSES[targetColumn][0];
    if (!targetStatus) return;

    const previousColumns = columns;
    setColumns((prev) => ({
      ...prev,
      [sourceColumn as PipelineColumnKey]: {
        ...prev[sourceColumn as PipelineColumnKey],
        cards: prev[sourceColumn as PipelineColumnKey].cards.filter(
          (c) => c.id !== draggedLead!.id,
        ),
      },
      [targetColumn]: {
        ...prev[targetColumn],
        cards: [{ ...draggedLead, status: targetStatus }, ...prev[targetColumn].cards],
      },
    }));

    const errorMessage = await applyStatusChange(draggedLead.id, targetStatus);
    if (errorMessage) {
      setColumns(previousColumns);
      setError(errorMessage);
      setAnnouncement(`Move rejected: ${errorMessage}`);
    } else {
      setAnnouncement(
        `${draggedLead.initials ?? 'Lead'} moved to ${PIPELINE_COLUMN_LABELS[targetColumn]}`,
      );
      void fetchBoard();
    }
  }

  async function openMoveMenu(lead: LeadListItem) {
    setMoveMenuLead(lead);
    setMoveLoading(true);
    setMoveOptions([]);
    const res = await fetch(`/api/leads/${lead.id}/valid-next-statuses`);
    setMoveLoading(false);
    if (res.ok) {
      const json = (await res.json()) as { data: { normal_next_statuses: LeadStatus[] } };
      setMoveOptions(json.data.normal_next_statuses);
    }
  }

  async function handleMoveMenuSelect(newStatus: LeadStatus) {
    if (!moveMenuLead) return;
    const errorMessage = await applyStatusChange(moveMenuLead.id, newStatus);
    setMoveMenuLead(null);
    if (errorMessage) {
      setError(errorMessage);
      setAnnouncement(`Move rejected: ${errorMessage}`);
    } else {
      setAnnouncement(
        `${moveMenuLead.initials ?? 'Lead'} moved to ${newStatus.replace(/_/g, ' ')}`,
      );
      void fetchBoard();
    }
  }

  return (
    <div>
      <PageHeader
        title="Recruitment"
        description="Drag a lead between stages, or use Move to… for a keyboard-accessible alternative"
      />

      <RecruitmentViewTabs />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Select
          value={get('site_id')}
          onChange={(e) => setMany({ site_id: e.target.value })}
          placeholder="All sites (incl. pool)"
          options={sites.map((s) => ({ value: s.id, label: s.name }))}
        />
        <Select
          value={get('study_id')}
          onChange={(e) => setMany({ study_id: e.target.value })}
          placeholder="All studies"
          options={studies.map((s) => ({ value: s.id, label: s.study_name }))}
        />
        <Select
          value={get('assigned_user_id')}
          onChange={(e) => setMany({ assigned_user_id: e.target.value })}
          placeholder="All owners"
          options={users.map((u) => ({ value: u.id, label: u.full_name }))}
        />
        <Select
          value={get('priority')}
          onChange={(e) => setMany({ priority: e.target.value })}
          placeholder="All priorities"
          options={PRIORITY_OPTIONS}
        />
      </div>

      {error && (
        <div className="mb-4">
          <AlertBanner variant="error" message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {!counts ? (
        <div className="flex h-48 items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      ) : (
        <DndContext sensors={sensors} onDragEnd={(e) => void handleDragEnd(e)}>
          <div className="flex gap-3 overflow-x-auto pb-4">
            {PIPELINE_COLUMN_ORDER.map((column) => (
              <PipelineColumnDroppable
                key={column}
                column={column}
                count={counts.columns.find((c) => c.column === column)?.count ?? 0}
                state={columns[column]}
                users={users}
                onLoadMore={() => void fetchColumnCards(column, columns[column].page + 1)}
                onOpenMoveMenu={(lead) => void openMoveMenu(lead)}
              />
            ))}
          </div>
        </DndContext>
      )}

      <Modal
        open={moveMenuLead !== null}
        onClose={() => setMoveMenuLead(null)}
        title={`Move ${moveMenuLead?.initials ?? 'lead'}`}
      >
        <div className="space-y-3">
          {moveLoading ? (
            <div className="flex justify-center py-4">
              <LoadingSpinner size="sm" />
            </div>
          ) : moveOptions.length === 0 ? (
            <p className="text-sm text-gray-500">
              No normal next status is available for this lead from its current status.
            </p>
          ) : (
            <div className="space-y-2">
              {moveOptions.map((status) => (
                <Button
                  key={status}
                  variant="outline"
                  className="w-full justify-start capitalize"
                  onClick={() => void handleMoveMenuSelect(status)}
                >
                  {status.replace(/_/g, ' ')}
                </Button>
              ))}
            </div>
          )}
          <div className="flex justify-end pt-2">
            <Button variant="ghost" onClick={() => setMoveMenuLead(null)}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default function RecruitmentPipelinePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      }
    >
      <RecruitmentPipelineContent />
    </Suspense>
  );
}
