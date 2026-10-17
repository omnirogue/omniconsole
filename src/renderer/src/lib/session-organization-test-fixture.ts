import { vi } from 'vitest'
import { createSessionFoldersStore } from '@/store/session-folders'
import { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import type { OrganizationRpc } from './session-organization-change'
import type { OrganizationStores } from './session-organization-values'
import type { SessionFolderMetadata } from './session-folders'
import { emptySessionSidebarView } from './session-sidebar-view'

export const SALES = '00000000-0000-4000-8000-000000000001'
export const CHECKOUT = '00000000-0000-4000-8000-000000000002'

/** Real sidebar stores over in-memory storage: `a` is in Sales, `b` unfiled. */
export function createOrganizationTestStores(
  metadata: Partial<SessionFolderMetadata> = {}
): OrganizationStores {
  let saved: SessionFolderMetadata = {
    version: 1,
    folders: [
      { id: SALES, name: 'Sales' },
      { id: CHECKOUT, name: 'Checkout' }
    ],
    membership: { a: SALES },
    ...metadata
  }
  const folders = createSessionFoldersStore({
    save: (next) => {
      saved = next
    },
    load: () => saved
  })
  const view = createSessionSidebarViewStore(
    { save: vi.fn(), load: vi.fn(() => emptySessionSidebarView()) },
    { save: vi.fn(), load: vi.fn(() => []) }
  )
  folders.getState().load()
  view.getState().load()
  return { folders, view }
}

export type OrganizationRpcCall = { method: string; params: Record<string, unknown> }

/** Records every call; an `answers` entry that is a function runs (and may throw). */
export function fakeOrganizationRpc(answers: Record<string, unknown> = {}) {
  const calls: OrganizationRpcCall[] = []
  const rpc = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params: params as Record<string, unknown> })
    const answer = answers[method]
    return typeof answer === 'function' ? (answer as () => unknown)() : (answer ?? {})
  }) as unknown as OrganizationRpc
  return { rpc, calls }
}
