import { create } from 'zustand'

export type ReadyProvider = 'claude' | 'codex'
export type ReadyDraft = { text: string; model?: string; effort?: string; account?: string }
export type ReadySubmission = {
  id: string
  provider: ReadyProvider
  status: 'validating' | 'starting' | 'attached' | 'failed' | 'uncertain'
  worktreeId?: string
  hostId?: string
  tabId?: string
  delivered?: boolean
  boundPaneId?: string
  sourceShown?: boolean
  error?: string
  timings: {
    submitted: number
    validated?: number
    published?: number
    delivered?: number
    attached?: number
  }
}
export type ReadyPaneDrafts = {
  provider: ReadyProvider
  drafts: Record<ReadyProvider, ReadyDraft>
  workspace: string
  fresh: 'slot' | 'tray'
  submission?: ReadySubmission
}
type ReadyDocument = {
  version: 1
  panes: Record<string, ReadyPaneDrafts>
  traces: ReadySubmission[]
}
const empty = (): ReadyDocument => ({ version: 1, panes: {}, traces: [] })
export const emptyReadyPane = (): ReadyPaneDrafts => ({
  provider: 'claude',
  drafts: { claude: { text: '' }, codex: { text: '' } },
  workspace: '',
  fresh: 'slot'
})
const key = (scope: string) => `omni.ready-panes.v1:${scope}`
function validDraft(draft: ReadyDraft | undefined): boolean {
  return Boolean(
    draft &&
    typeof draft.text === 'string' &&
    [draft.model, draft.effort, draft.account].every(
      (value) => value === undefined || typeof value === 'string'
    )
  )
}
function validSubmission(submission: ReadySubmission): boolean {
  return Boolean(
    submission &&
    typeof submission.id === 'string' &&
    ['claude', 'codex'].includes(submission.provider) &&
    ['validating', 'starting', 'attached', 'failed', 'uncertain'].includes(submission.status) &&
    submission.timings &&
    Number.isFinite(submission.timings.submitted) &&
    Object.values(submission.timings).every((value) => Number.isFinite(value)) &&
    [
      submission.worktreeId,
      submission.hostId,
      submission.tabId,
      submission.error,
      submission.boundPaneId
    ].every((value) => value === undefined || typeof value === 'string') &&
    (submission.delivered === undefined || typeof submission.delivered === 'boolean') &&
    (submission.sourceShown === undefined || typeof submission.sourceShown === 'boolean')
  )
}
export const useReadyPaneDrafts = create<{
  documents: Record<string, ReadyDocument>
  errors: Record<string, string | undefined>
}>(() => ({ documents: {}, errors: {} }))

export function loadReadyPaneDrafts(scope: string): void {
  if (useReadyPaneDrafts.getState().documents[scope]) {
    return
  }
  let document = empty()
  let error: string | undefined
  try {
    const raw = localStorage.getItem(key(scope))
    if (raw) {
      const value = JSON.parse(raw) as ReadyDocument
      if (
        value.version !== 1 ||
        !value.panes ||
        typeof value.panes !== 'object' ||
        Array.isArray(value.panes) ||
        !Array.isArray(value.traces) ||
        !value.traces.every(validSubmission)
      ) {
        throw new Error('Unsupported ready drafts')
      }
      for (const pane of Object.values(value.panes)) {
        if (
          !pane?.drafts ||
          !validDraft(pane.drafts.claude) ||
          !validDraft(pane.drafts.codex) ||
          !['claude', 'codex'].includes(pane.provider) ||
          typeof pane.workspace !== 'string' ||
          !['slot', 'tray'].includes(pane.fresh) ||
          (pane.submission !== undefined && !validSubmission(pane.submission))
        ) {
          throw new Error('Unreadable ready drafts')
        }
        if (pane.submission && ['starting', 'attached'].includes(pane.submission.status)) {
          pane.submission = {
            ...pane.submission,
            status: 'uncertain',
            error: 'The launch was interrupted. Check for its session before retrying.'
          }
        }
        if (pane.submission?.status === 'validating') {
          pane.submission = {
            ...pane.submission,
            status: 'failed',
            error: 'Validation was interrupted. Nothing launched.'
          }
        }
      }
      document = value
    }
  } catch {
    error =
      'Ready drafts could not be read. The saved copy has been preserved; sending is disabled.'
  }
  useReadyPaneDrafts.setState((state) => ({
    documents: { ...state.documents, [scope]: document },
    errors: { ...state.errors, [scope]: error }
  }))
}

export function updateReadyPane(
  scope: string,
  paneId: string,
  update: (pane: ReadyPaneDrafts) => ReadyPaneDrafts
): boolean {
  loadReadyPaneDrafts(scope)
  const state = useReadyPaneDrafts.getState()
  if (state.errors[scope]) {
    return false
  }
  const current = state.documents[scope]
  const next = {
    ...current,
    panes: { ...current.panes, [paneId]: update(current.panes[paneId] ?? emptyReadyPane()) }
  }
  try {
    localStorage.setItem(key(scope), JSON.stringify(next))
    useReadyPaneDrafts.setState({ documents: { ...state.documents, [scope]: next } })
    return true
  } catch {
    useReadyPaneDrafts.setState({
      errors: {
        ...state.errors,
        [scope]: 'Ready drafts could not be saved. Sending is disabled until storage is available.'
      }
    })
    return false
  }
}

export function updateReadySubmission(
  scope: string,
  paneId: string,
  id: string,
  patch: Partial<ReadySubmission>
): void {
  updateReadyPane(scope, paneId, (pane) =>
    pane.submission?.id === id ? { ...pane, submission: { ...pane.submission, ...patch } } : pane
  )
}

export function finishReadySubmission(scope: string, paneId: string, id: string): boolean {
  const state = useReadyPaneDrafts.getState()
  const document = state.documents[scope]
  const pane = document?.panes[paneId]
  const submission = pane?.submission
  if (!submission || submission.id !== id || !submission.delivered) {
    return false
  }
  const attached = {
    ...submission,
    status: 'attached' as const,
    timings: { ...submission.timings, attached: submission.timings.attached ?? Date.now() }
  }
  const next = {
    ...document,
    panes: {
      ...document.panes,
      [paneId]: {
        ...pane,
        submission: undefined,
        drafts: {
          ...pane.drafts,
          [submission.provider]: { ...pane.drafts[submission.provider], text: '' }
        }
      }
    },
    traces: [...document.traces, attached].slice(-32)
  }
  try {
    localStorage.setItem(key(scope), JSON.stringify(next))
    useReadyPaneDrafts.setState({ documents: { ...state.documents, [scope]: next } })
    return true
  } catch {
    useReadyPaneDrafts.setState({
      errors: {
        ...state.errors,
        [scope]: 'Prompt delivered, but the draft could not be saved. The draft has been kept.'
      }
    })
    return false
  }
}

export function readySubmissionInFlight(submission: ReadySubmission | undefined): boolean {
  return Boolean(
    submission && ['validating', 'starting', 'attached', 'uncertain'].includes(submission.status)
  )
}
