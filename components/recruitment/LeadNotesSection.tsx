'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { usePermissions } from '@/hooks/usePermissions';
import { useAuth } from '@/hooks/useAuth';
import type { LeadNote, LeadNoteType } from '@/types/recruitment';

const NOTE_TYPE_OPTIONS: Array<{ value: LeadNoteType; label: string }> = [
  { value: 'general', label: 'General' },
  { value: 'call_summary', label: 'Call Summary' },
  { value: 'eligibility', label: 'Eligibility' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'other', label: 'Other' },
];

export function LeadNotesSection({ leadId }: { leadId: string }) {
  const { hasPermission } = usePermissions();
  const auth = useAuth();
  const currentUserId = auth.status === 'authenticated' ? auth.profile.id : null;
  const canView = hasPermission('view_lead_notes') || hasPermission('create_lead_note');
  const canCreate = hasPermission('create_lead_note');

  const [notes, setNotes] = useState<LeadNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [noteType, setNoteType] = useState<LeadNoteType>('general');
  const [body, setBody] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');

  const fetchNotes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/leads/${leadId}/notes`);
      if (res.ok) {
        const json = (await res.json()) as { data: LeadNote[] };
        setNotes(json.data);
      }
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    if (canView) void fetchNotes();
    else setLoading(false);
  }, [canView, fetchNotes]);

  async function handleAdd() {
    if (!body.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note_type: noteType, body, is_private: isPrivate }),
      });
      const json = (await res.json()) as { success: boolean; error?: { message: string } };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to add note');
        return;
      }
      setBody('');
      setIsPrivate(false);
      void fetchNotes();
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveEdit(noteId: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/notes/${noteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: editBody }),
      });
      const json = (await res.json()) as { success: boolean; error?: { message: string } };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to update note');
        return;
      }
      setEditingId(null);
      void fetchNotes();
    } finally {
      setSaving(false);
    }
  }

  if (!canView) return null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-900">Notes</h3>

      {loading ? (
        <div className="flex justify-center py-4">
          <LoadingSpinner size="sm" />
        </div>
      ) : notes.length === 0 ? (
        <p className="text-sm text-gray-500">No notes yet.</p>
      ) : (
        <ul className="mb-4 space-y-3">
          {notes.map((note) => (
            <li key={note.id} className="rounded-lg border border-gray-100 p-3 text-sm">
              {editingId === note.id ? (
                <div className="space-y-2">
                  <textarea
                    className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    rows={3}
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      loading={saving}
                      disabled={saving || !editBody.trim()}
                      onClick={() => void handleSaveEdit(note.id)}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-1 flex items-center justify-between text-xs text-gray-400">
                    <span className="capitalize">
                      {note.note_type.replace(/_/g, ' ')}
                      {note.is_private && ' · Private'}
                    </span>
                    <span>{new Date(note.created_at).toLocaleString()}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-gray-700">{note.body}</p>
                  {canCreate && note.created_by === currentUserId && (
                    <button
                      type="button"
                      className="mt-1 text-xs font-medium text-blue-600 hover:underline"
                      onClick={() => {
                        setEditingId(note.id);
                        setEditBody(note.body);
                      }}
                    >
                      Edit
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {canCreate && (
        <div className="space-y-2 border-t border-gray-100 pt-3">
          <Select
            value={noteType}
            onChange={(e) => setNoteType(e.target.value as LeadNoteType)}
            options={NOTE_TYPE_OPTIONS}
          />
          <textarea
            className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
            rows={2}
            placeholder="Add a note…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs text-gray-500">
              <input
                type="checkbox"
                checked={isPrivate}
                onChange={(e) => setIsPrivate(e.target.checked)}
              />
              Private (only visible to me)
            </label>
            <Button
              size="sm"
              loading={saving}
              disabled={saving || !body.trim()}
              onClick={() => void handleAdd()}
            >
              Add Note
            </Button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
