// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactListItem, ArtifactMetadata } from '../../../../shared/artifacts'

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  rpc: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastDismiss: vi.fn(),
  openLinkedSession: vi.fn(),
  stable: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    dismiss: mocks.toastDismiss,
    message: vi.fn()
  })
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => mocks.confirm
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/open-linked-session', () => ({ openLinkedSession: mocks.openLinkedSession }))
vi.mock('@/lib/sidebar-sessions', () => ({ buildSidebarSessions: () => [] }))
vi.mock('./ArtifactPreview', () => ({ ArtifactPreview: () => null }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeState()),
    { getState: storeState }
  )
}))

// Why stable references: a new refresh function per render would restart the list load.
const STORE = {
  closeArtifactsPage: mocks.stable,
  connectCurrentOrcaProfile: mocks.stable,
  orcaProfileAuthStatus: {
    activeProfileId: 'profile-a',
    cloud: { cloudProfileId: 'cloud-a', userId: 'user-a' },
    configured: true,
    state: 'connected'
  },
  orcaProfileConnecting: false,
  refreshCurrentOrcaProfileAuth: mocks.stable,
  settings: { artifactSharingEnabled: true },
  updateSettings: mocks.stable,
  openSettingsPage: mocks.stable,
  openSettingsTarget: mocks.stable
}

function storeState(): Record<string, unknown> {
  return STORE
}

import ArtifactsPage from './ArtifactsPage'

function page(
  slug: string,
  title: string,
  extra: Partial<ArtifactMetadata> = {}
): ArtifactMetadata {
  return {
    version: 1,
    slug,
    title,
    originalFileName: null,
    sourceContentType: 'text/html',
    renderedContentType: 'text/html',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    byteSize: 10,
    deletedAt: null,
    ...extra
  }
}

function lifecycleRow(slug: string, title: string, approved: boolean): ArtifactListItem {
  return {
    artifact: page(slug, title, {
      revision: 3,
      audience: 'team',
      review: { question: 'Ship?', reviewers: [], status: 'pending', statusAt: null },
      lifecycle: null,
      closedAt: null,
      closedRef: null,
      supersededBy: null,
      supersededAt: null
    }),
    shareUrl: `https://omnios.example/a/${slug}`,
    needsYou: !approved,
    lastDecision: approved
      ? { revision: 3, decision: 'approved', at: '2026-09-03T00:00:00Z' }
      : null,
    sessionRef: null,
    sessionAgent: null
  }
}

function listResponse(artifacts: ArtifactListItem[]): unknown {
  return { status: 'ok', value: { artifacts } }
}

describe('ArtifactsPage lifecycle', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset()
    }
    mocks.confirm.mockResolvedValue(true)
    Object.assign(window, {
      api: { ui: { writeClipboardText: vi.fn() }, shell: { openUrl: vi.fn() } }
    })
  })

  afterEach(cleanup)

  it('renders an older server list as before: no filter, no selection, no state sent', async () => {
    mocks.rpc.mockResolvedValue(
      listResponse([
        { artifact: page('old', 'Old page'), shareUrl: 'https://omnios.example/a/old' }
      ])
    )
    render(<ArtifactsPage />)

    expect(await screen.findByRole('button', { name: /Old page/ })).toBeInTheDocument()
    expect(screen.getByText('Type')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Show pages' })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('toolbar', { name: 'Selected pages' })).toBeNull()
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'artifacts.list', {})
  })

  it('sends state only after the server shows lifecycle keys, and restarts on a filter change', async () => {
    mocks.rpc.mockResolvedValue(listResponse([lifecycleRow('a', 'Alpha plan', false)]))
    render(<ArtifactsPage />)

    expect(await screen.findByRole('button', { name: /Alpha plan/ })).toBeInTheDocument()
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'artifacts.list', { state: 'open' })
    )
    expect(mocks.rpc.mock.calls[0]).toEqual([{ kind: 'local' }, 'artifacts.list', {}])
    expect(screen.getByText('Needs you')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('radio', { name: 'Closed' }))
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenLastCalledWith({ kind: 'local' }, 'artifacts.list', {
        state: 'closed'
      })
    )
  })

  it('confirms counts and skips, sends each row fenced, then undoes with the exact inverse', async () => {
    const rows = [lifecycleRow('a', 'Alpha plan', true), lifecycleRow('b', 'Beta plan', false)]
    mocks.rpc.mockImplementation(async (_target: unknown, method: string, params: unknown) => {
      if (method === 'artifacts.list') {
        return listResponse(rows)
      }
      if (method === 'artifacts.lifecycle') {
        const { id, body } = params as { id: string; body: { action: string } }
        const row = rows.find((item) => item.artifact.slug === id)!
        const closed = body.action === 'close'
        return {
          status: 'ok',
          value: {
            artifact: {
              ...row.artifact,
              lifecycle: closed ? 'done' : null,
              closedAt: closed ? '2026-09-30T12:00:00.123456+00:00' : null
            },
            shareUrl: row.shareUrl,
            status: 'pending',
            latest: null,
            decisions: [],
            viewer: { signedIn: true, isOwner: true, canDecide: false }
          }
        }
      }
      return null
    })
    render(<ArtifactsPage />)
    await screen.findByRole('button', { name: /Alpha plan/ })
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBe(3))

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all loaded pages' }))
    const bar = screen.getByRole('toolbar', { name: 'Selected pages' })
    expect(within(bar).getByText('2 selected')).toBeInTheDocument()
    await userEvent.click(within(bar).getByRole('button', { name: /Mark done/ }))

    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: '1 page(s) will be closed as “Mark done”.\n1 skipped: 1 not approved.'
      })
    )
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled())
    const lifecycleCalls = mocks.rpc.mock.calls.filter(
      ([, method]) => method === 'artifacts.lifecycle'
    )
    expect(lifecycleCalls).toEqual([
      [
        { kind: 'local' },
        'artifacts.lifecycle',
        { id: 'a', body: { action: 'close', revision: 3, lifecycle: 'done', expect: 'open' } }
      ]
    ])
    expect(await screen.findByText('Done')).toBeInTheDocument()

    const [summary, options] = mocks.toastSuccess.mock.calls.at(-1)!
    expect(summary).toBe('1 changed · 1 skipped: Beta plan')
    expect(options.duration).toBe(Infinity)
    options.action.onClick()
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenLastCalledWith({ kind: 'local' }, 'artifacts.lifecycle', {
        id: 'a',
        body: { action: 'reopen', revision: 3, closedAt: '2026-09-30T12:00:00.123456+00:00' }
      })
    )
  })
})
