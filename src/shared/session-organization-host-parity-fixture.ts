/**
 * One scenario the window's change path and the host's headless path both run, and the history
 * and Undo outcomes both must produce: history and Undo work the same with or without a window.
 * Operation ids are the step ids, so records compare directly.
 */

import type {
  OrganizationChange,
  OrganizationExecutor,
  OrganizationRecord,
  OrganizationUndoTarget
} from './session-organization-change'

export const PARITY_FOLDER_ONE = '00000000-0000-4000-8000-00000000000a'
export const PARITY_FOLDER_TWO = '00000000-0000-4000-8000-00000000000b'
export const PARITY_TAG = 'betacorp'
export const PARITY_A = 'session-a'
export const PARITY_B = 'session-b'
export const PARITY_C = 'session-c'
/** The tab session A's title lives on in the window (the host names the session only). */
export const PARITY_TAB_A = 'tab-a'

const AGENT: OrganizationExecutor = { kind: 'pane', paneKey: 'tab-9:leaf-1', title: 'Steward' }
const PERSON: OrganizationExecutor = { kind: 'person', via: 'sidebar' }

export type ParityStep =
  | { do: 'change'; id: string; change: Omit<OrganizationChange, 'opId'> }
  | { do: 'undo'; id: string; of: string }

export const PARITY_STEPS: ParityStep[] = [
  {
    do: 'change',
    id: 'file',
    change: {
      kind: 'move',
      targets: [{ sessionKey: PARITY_A }, { sessionKey: PARITY_B }],
      value: PARITY_FOLDER_ONE,
      executor: AGENT,
      reason: 'group the review work'
    }
  },
  {
    do: 'change',
    id: 'refile',
    change: {
      kind: 'move',
      targets: [{ sessionKey: PARITY_B }],
      value: PARITY_FOLDER_TWO,
      executor: PERSON
    }
  },
  { do: 'undo', id: 'undo-file', of: 'file' },
  {
    do: 'change',
    id: 'tag',
    change: {
      kind: 'tag',
      targets: [{ sessionKey: PARITY_A }],
      value: PARITY_TAG,
      executor: AGENT,
      reason: 'needs review'
    }
  },
  {
    do: 'change',
    id: 'hide',
    change: {
      kind: 'hide',
      targets: [{ sessionKey: PARITY_C }],
      value: true,
      executor: AGENT,
      reason: 'parked'
    }
  },
  { do: 'undo', id: 'undo-tag', of: 'tag' },
  {
    do: 'change',
    id: 'retitle',
    change: {
      kind: 'title',
      targets: [{ sessionKey: PARITY_A }],
      value: 'Review notes',
      origin: 'generated',
      executor: AGENT
    }
  },
  {
    do: 'change',
    id: 'archive',
    change: {
      kind: 'archive',
      targets: [{ sessionKey: PARITY_C }],
      value: true,
      executor: { kind: 'app', feature: 'auto-archive' }
    }
  },
  { do: 'undo', id: 'undo-archive', of: 'archive' },
  { do: 'undo', id: 'undo-retitle', of: 'retitle' }
]

export type ParityRecord = {
  opId: string
  kind: string
  by: string
  keys: string[]
  before: unknown[] | undefined
  after: unknown[] | undefined
  undoOf?: string
}

export const PARITY_EXPECTED_HISTORY: ParityRecord[] = [
  {
    opId: 'file',
    kind: 'move',
    by: 'pane',
    keys: [PARITY_A, PARITY_B],
    before: [null, null],
    after: [PARITY_FOLDER_ONE, PARITY_FOLDER_ONE]
  },
  {
    opId: 'refile',
    kind: 'move',
    by: 'person',
    keys: [PARITY_B],
    before: [PARITY_FOLDER_ONE],
    after: [PARITY_FOLDER_TWO]
  },
  {
    opId: 'undo-file',
    kind: 'move',
    by: 'person',
    keys: [PARITY_A],
    before: [PARITY_FOLDER_ONE],
    after: [null],
    undoOf: 'file'
  },
  { opId: 'tag', kind: 'tag', by: 'pane', keys: [PARITY_A], before: [false], after: [true] },
  { opId: 'hide', kind: 'hide', by: 'pane', keys: [PARITY_C], before: [false], after: [true] },
  {
    opId: 'undo-tag',
    kind: 'untag',
    by: 'person',
    keys: [PARITY_A],
    before: [true],
    after: [false],
    undoOf: 'tag'
  },
  {
    opId: 'retitle',
    kind: 'title',
    by: 'pane',
    keys: [PARITY_A],
    before: [null],
    after: ['Review notes']
  },
  { opId: 'archive', kind: 'archive', by: 'app', keys: [PARITY_C], before: [false], after: [true] },
  {
    opId: 'undo-archive',
    kind: 'unarchive',
    by: 'person',
    keys: [PARITY_C],
    before: [true],
    after: [false],
    undoOf: 'archive'
  },
  {
    opId: 'undo-retitle',
    kind: 'title',
    by: 'person',
    keys: [PARITY_A],
    before: ['Review notes'],
    after: [null],
    undoOf: 'retitle'
  }
]

export type ParityUndo = {
  undone: number
  total: number
  skipped: OrganizationUndoTarget['status'][]
}

export const PARITY_EXPECTED_UNDO: Record<string, ParityUndo> = {
  // B was re-filed by the person after the agent filed it: skipped, never overwritten.
  'undo-file': { undone: 1, total: 2, skipped: ['changed-since'] },
  'undo-tag': { undone: 1, total: 1, skipped: [] },
  'undo-archive': { undone: 1, total: 1, skipped: [] },
  'undo-retitle': { undone: 1, total: 1, skipped: [] }
}

export function parityRecord(record: OrganizationRecord): ParityRecord {
  return {
    opId: record.opId,
    kind: record.kind,
    by: record.executor.kind,
    keys: record.targets.map((target) => target.sessionKey ?? ''),
    before: record.before,
    after: record.after,
    ...(record.undoOf ? { undoOf: record.undoOf } : {})
  }
}
