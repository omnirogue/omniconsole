import { describe, expect, it, vi } from 'vitest'
import { createSessionFoldersStore } from '@/store/session-folders'
import { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import { announceArchiveChanges } from '@/store/session-sidebar-view-archive-notices'
import { archiveSleepViaOf } from '../../../shared/archive-sleep-contract'
import type { OrganizationExecutor } from '../../../shared/session-organization-change'
import { currentArchiveExecutor, type ConversationArchiveEvent } from './session-archive-events'
import { applySessionFolderOp } from './session-folder-cli-apply'
import {
  applyOrganizationChange,
  applyPersonOrganizationChange,
  type OrganizationRpc
} from './session-organization-change'
import type { OrganizationStores } from './session-organization-values'
import { emptySessionFolderMetadata } from './session-folders'
import { emptySessionSidebarView } from './session-sidebar-view'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

function stores(): { stores: OrganizationStores; events: ConversationArchiveEvent[] } {
  const folders = createSessionFoldersStore({
    save: vi.fn(),
    load: vi.fn(() => emptySessionFolderMetadata())
  })
  const view = createSessionSidebarViewStore(
    { save: vi.fn(), load: vi.fn(() => emptySessionSidebarView()) },
    { save: vi.fn(), load: vi.fn(() => []) }
  )
  folders.getState().load()
  view.getState().load()
  const events: ConversationArchiveEvent[] = []
  announceArchiveChanges(view, (event) => events.push(event))
  return { stores: { folders, view }, events }
}

const rpc = vi.fn(async () => ({})) as unknown as OrganizationRpc

describe('who archived, as the archive notice names it', () => {
  it('names a person only for a person’s own change', () => {
    const { stores: s, events } = stores()
    applyPersonOrganizationChange(
      {
        kind: 'archive',
        targets: [{ sessionKey: 'a' }],
        value: true,
        executor: { kind: 'person', via: 'sidebar' }
      },
      { stores: s, rpc }
    )
    expect(events).toEqual([{ keys: ['a'], archived: true, via: 'person' }])
    expect(currentArchiveExecutor()).toBeNull()
  })

  it.each<[OrganizationExecutor, string]>([
    [{ kind: 'cli' }, 'cli'],
    [{ kind: 'pane', paneKey: 'tab-9:leaf', title: 'Worker' }, 'pane'],
    [{ kind: 'sync', stamp: 1 }, 'sync'],
    [{ kind: 'app', feature: 'transfer' }, 'transfer']
  ])('names %o as %s', async (executor, via) => {
    const { stores: s, events } = stores()
    const outcome = await applyOrganizationChange(
      { kind: 'archive', targets: [{ sessionKey: 'a' }], value: true, executor },
      { stores: s, rpc }
    )
    expect(outcome.status).toBe('applied')
    expect(events).toEqual([{ keys: ['a'], archived: true, via }])
  })

  it('names the CLI request’s own executor, and the plain CLI when it names none', () => {
    const { stores: s, events } = stores()
    const session = (key: string) => ({ key, label: key })
    const op = (paneKey: string) =>
      ({ kind: 'archiveSession', paneKey, archived: true }) as const
    applySessionFolderOp(op('p1'), s, session('p1'), { kind: 'pane', paneKey: 'x', title: 't' })
    applySessionFolderOp(op('p2'), s, session('p2'))
    expect(events.map((event) => event.via)).toEqual(['pane', 'cli'])
  })

  it('maps every executor, and nothing unnamed to a person', () => {
    expect(archiveSleepViaOf(undefined)).toBe('unknown')
    expect(archiveSleepViaOf({ kind: 'launch', source: 'session-launch' })).toBe('app')
    expect(archiveSleepViaOf({ kind: 'app', feature: 'steward' })).toBe('steward')
    expect(archiveSleepViaOf({ kind: 'app', feature: 'auto-archive' })).toBe('auto-archive')
    expect(archiveSleepViaOf({ kind: 'app', feature: 'finish' })).toBe('app')
  })
})
