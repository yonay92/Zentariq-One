import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DocumentCenterView } from '@/components/documents/DocumentCenterView';
import type { FileWithLinks } from '@/types/files';
import type { Profile } from '@/types/users';

const USER_ID = 'user-1';

function makeFile(overrides: Partial<FileWithLinks> = {}): FileWithLinks {
  return {
    id: 'file-1',
    company_id: 'company-1',
    file_name: 'protocol.pdf',
    original_name: 'protocol.pdf',
    file_extension: 'pdf',
    mime_type: 'application/pdf',
    file_size: 204800,
    storage_path: 'company-1/uuid_protocol.pdf',
    uploaded_by: USER_ID,
    uploaded_at: '2026-08-01T12:00:00Z',
    checksum: 'abc123',
    ai_processed: false,
    links: [],
    ...overrides,
  };
}

function makeUser(overrides: Partial<Profile> = {}): Profile {
  return {
    id: USER_ID,
    company_id: 'company-1',
    full_name: 'Jane Doe',
    email: 'jane@example.com',
    phone: null,
    avatar_file_id: null,
    status: 'active',
    last_login_at: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function mockFetchFor(options: {
  files: FileWithLinks[];
  users?: Profile[];
  permissions?: string[];
  filesStatus?: number;
}) {
  const permissions = options.permissions ?? ['view_documents', 'upload_documents'];
  const status = options.filesStatus ?? 200;

  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (data: unknown, ok = true, s = 200) =>
      Promise.resolve({
        ok,
        status: s,
        json: () => Promise.resolve({ data }),
      } as Response);

    if (url === '/api/users/me/permissions') return json({ permissions });
    if (url.startsWith('/api/files?')) return json(options.files, status === 200, status);
    if (url === '/api/users') return json(options.users ?? []);

    return Promise.resolve({ ok: false, json: () => Promise.resolve({ data: null }) } as Response);
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DocumentCenterView — browsing', () => {
  it('renders the file list with size and uploader once loaded', async () => {
    global.fetch = mockFetchFor({ files: [makeFile()], users: [makeUser()] });
    render(<DocumentCenterView />);

    expect(await screen.findByText('protocol.pdf')).toBeTruthy();
    const table = screen.getByRole('table');
    expect(within(table).getByText('200.0 KB')).toBeTruthy();
    expect(within(table).getByText('Jane Doe')).toBeTruthy();
  });

  it('shows the empty state when there are no files', async () => {
    global.fetch = mockFetchFor({ files: [] });
    render(<DocumentCenterView />);

    expect(await screen.findByText('No documents yet')).toBeTruthy();
  });

  it('shows a permission error banner when the API returns 403', async () => {
    global.fetch = mockFetchFor({ files: [], filesStatus: 403 });
    render(<DocumentCenterView />);

    expect(
      await screen.findByText('You do not have permission to view the Document Center.'),
    ).toBeTruthy();
  });

  it('only shows the Upload File button when the caller holds upload_documents', async () => {
    global.fetch = mockFetchFor({ files: [], permissions: ['view_documents'] });
    render(<DocumentCenterView />);

    await waitFor(() => expect(screen.getByText('No documents yet')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Upload File' })).toBeNull();
  });
});

describe('DocumentCenterView — preview panel', () => {
  it('opens the preview modal with metadata and "No linked records" for an unlinked file', async () => {
    global.fetch = mockFetchFor({ files: [makeFile()], users: [makeUser()] });
    render(<DocumentCenterView />);

    await screen.findByText('protocol.pdf');
    await userEvent.click(screen.getByRole('button', { name: 'View' }));

    const dialog = await screen.findByRole('dialog', { name: 'protocol.pdf' });
    expect(within(dialog).getByText('No linked records')).toBeTruthy();
  });

  it('shows linked module/record information for a linked file', async () => {
    const linked = makeFile({
      links: [
        {
          id: 'link-1',
          company_id: 'company-1',
          file_id: 'file-1',
          site_id: null,
          module: 'subjects',
          record_id: 'record-uuid',
          created_by: USER_ID,
          created_at: '',
        },
      ],
    });
    global.fetch = mockFetchFor({ files: [linked], users: [makeUser()] });
    render(<DocumentCenterView />);

    await screen.findByText('protocol.pdf');
    await userEvent.click(screen.getByRole('button', { name: 'View' }));

    const dialog = await screen.findByRole('dialog', { name: 'protocol.pdf' });
    expect(within(dialog).getByText('subjects')).toBeTruthy();
    expect(within(dialog).getByText('record-uuid')).toBeTruthy();
  });
});
