import { describe, expect, it, vi } from 'vitest'
import { setAutomaticArchiveChecks } from './session-automatic-archive-guard'
import { createSessionFoldersStore } from '@/store/session-folders'
import { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import { createSessionTagsStore } from '@/store/session-tags'
import { createWaitLaterStore } from '@/store/wait-later-store'
import {
  organizationTargetKey,
  revisionFieldOf,
  SESSION_ORGANIZATION_RPC,
  type OrganizationChange,
  type OrganizationRecord
} from '../../../shared/session-organization-change'
import {
  PARITY_A,
  PARITY_EXPECTED_HISTORY,
  PARITY_EXPECTED_UNDO,
  PARITY_FOLDER_ONE,
  PARITY_FOLDER_TWO,
  PARITY_STEPS,
  PARITY_TAB_A,
  parityRecord,
  type ParityUndo
} from '../../../shared/session-organization-host-parity-fixture'
import { planOrganizationUndo } from '../../../shared/session-organization-undo-plan'
import {
  applyOrganizationChange,
  undoOrganizationChange,
  type OrganizationRpc
} from './session-organization-change'
import type { OrganizationTitleStore } from './session-organization-title'
import type { OrganizationStores } from './session-organization-values'
import { emptySessionSidebarView } from './session-sidebar-view'
import { emptyWaitLater } from './wait-later'

// The host runs the same scenario headless in host-organization-parity.test.ts (main).

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

function windowStores(): OrganizationStores {
  const folders = createSessionFoldersStore({
    save: vi.fn(),
    load: vi.fn(() => ({
      version: 1 as const,
      folders: [
        { id: PARITY_FOLDER_ONE, name: 'Review' },
        { id: PARITY_FOLDER_TWO, name: 'Later' }
      ],
      membership: {}
    }))
  })
  const view = createSessionSidebarViewStore(
    { save: vi.fn(), load: vi.fn(() => emptySessionSidebarView()) },
    { save: vi.fn(), load: vi.fn(() => []) }
  )
  const backing = new Map<string, string>()
  const tags = createSessionTagsStore(() => ({
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => void backing.set(key, value)
  }))
  const waitLater = createWaitLaterStore({ load: () => emptyWaitLater(), save: vi.fn() })
  for (const store of [folders, view, tags, waitLater]) {
    store.getState().load()
  }
  const tabs = new Map<string, string | null>([[PARITY_TAB_A, null]])
  const titles: OrganizationTitleStore = {
    read: (tabId) =>
      tabs.has(tabId) ? { known: true, title: tabs.get(tabId)! } : { known: false },
    write: (tabId, title) => void tabs.set(tabId, title)
  }
  return { folders, view, tags, waitLater, titles }
}

/** Main's record path as the window sees it: prepared, settled, and main's own Undo plan. */
function windowMain() {
  const applied: OrganizationRecord[] = []
  const prepared = new Map<string, OrganizationRecord>()
  let seconds = 0
  const ts = () => new Date(Date.UTC(2026, 8, 26, 9, 0, (seconds += 1))).toISOString()
  const latestFor = (key: string, field: string) =>
    applied
      .toReversed()
      .find(
        (record) =>
          revisionFieldOf(record.kind) === field &&
          record.targets.some((target) => organizationTargetKey(target) === key)
      )
  const rpc = vi.fn(async (method: string, raw?: unknown) => {
    const params = raw as { change: OrganizationChange; before?: unknown[]; after?: unknown[] }
    if (method === SESSION_ORGANIZATION_RPC.prepare) {
      const change = params.change
      prepared.set(change.opId, { ...change, phase: 'prepared', ts: ts(), before: params.before })
      return { opId: change.opId }
    }
    if (method === SESSION_ORGANIZATION_RPC.settle) {
      const phase = (raw as { phase: 'applied' | 'failed' }).phase
      const held = prepared.get(params.change.opId)
      const record: OrganizationRecord = {
        ...(held ?? params.change),
        phase,
        ts: ts(),
        before: params.before ?? held?.before,
        after: params.after,
        revision: params.change.opId
      }
      if (phase === 'applied') {
        applied.push(record)
      }
      return { revision: record.revision }
    }
    if (method === SESSION_ORGANIZATION_RPC.undoPlan) {
      const record = applied.find((entry) => entry.opId === (raw as { opId: string }).opId)
      return planOrganizationUndo(record!, latestFor)
    }
    return {}
  }) as unknown as OrganizationRpc
  return { rpc, applied }
}

describe('history and Undo in the window', () => {
  it('match the host’s headless path step for step', async ({ onTestFinished }) => {
    // Eligibility precedes this shared history/Undo scenario on either host.
    onTestFinished(setAutomaticArchiveChecks({ refusal: () => null, receipt: () => 'proof' }))
    const stores = windowStores()
    const main = windowMain()
    const undos: Record<string, ParityUndo> = {}
    for (const step of PARITY_STEPS) {
      if (step.do === 'change') {
        // The window names a title's tab too; the host names only the session.
        const targets = step.change.targets.map((target) =>
          step.change.kind === 'title' && target.sessionKey === PARITY_A
            ? { ...target, tabId: PARITY_TAB_A }
            : target
        )
        const outcome = await applyOrganizationChange(
          { ...step.change, targets, opId: step.id },
          { rpc: main.rpc, stores, onApplied: () => {} }
        )
        expect(outcome.status, step.id).toBe('applied')
        continue
      }
      const undo = await undoOrganizationChange(step.of, {
        rpc: main.rpc,
        stores,
        mintOpId: () => step.id,
        onApplied: () => {}
      })
      undos[step.id] = {
        undone: undo.undone,
        total: undo.total,
        skipped: undo.skipped.map((entry) => entry.status)
      }
    }
    expect(main.applied.map(parityRecord)).toEqual(PARITY_EXPECTED_HISTORY)
    expect(undos).toEqual(PARITY_EXPECTED_UNDO)
  })
})
