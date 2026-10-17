/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadReadyPaneDrafts,
  updateReadyPane,
  updateReadySubmission,
  finishReadySubmission,
  useReadyPaneDrafts,
  readySubmissionInFlight
} from './ready-pane-drafts'

const read = (scope = 'account-a', paneId = 'ready') =>
  useReadyPaneDrafts.getState().documents[scope]?.panes[paneId]
const restart = () => useReadyPaneDrafts.setState({ documents: {}, errors: {} })
beforeEach(() => {
  localStorage.clear()
  restart()
  vi.restoreAllMocks()
})
afterEach(() => vi.unstubAllGlobals())

describe('ready pane draft retention and restart', () => {
  it('keeps separate Claude and Codex drafts across a restart, account and pane changes', () => {
    updateReadyPane('account-a', 'ready', (pane) => ({
      ...pane,
      workspace: 'folder:work',
      provider: 'codex',
      drafts: {
        claude: { text: 'Claude task', model: 'sonnet' },
        codex: { text: 'Codex task', effort: 'high', account: 'managed:a' }
      }
    }))
    updateReadyPane('account-b', 'ready', (pane) => ({
      ...pane,
      drafts: { ...pane.drafts, claude: { text: 'Other account' } }
    }))
    updateReadyPane('account-a', 'tray', (pane) => ({
      ...pane,
      drafts: { ...pane.drafts, claude: { text: 'Hidden pane' } }
    }))
    restart()
    loadReadyPaneDrafts('account-a')
    loadReadyPaneDrafts('account-b')
    expect(read()?.drafts.claude.text).toBe('Claude task')
    expect(read()?.drafts.codex).toMatchObject({
      text: 'Codex task',
      effort: 'high',
      account: 'managed:a'
    })
    expect(read()?.workspace).toBe('folder:work')
    expect(read('account-b')?.drafts.claude.text).toBe('Other account')
    expect(read('account-a', 'tray')?.drafts.claude.text).toBe('Hidden pane')
  })
  it.each(['failed', 'uncertain', 'starting', 'validating'] as const)(
    'never loses a draft when %s is interrupted',
    (status) => {
      updateReadyPane('account-a', 'ready', (pane) => ({
        ...pane,
        drafts: { ...pane.drafts, claude: { text: 'Keep me' } },
        submission: { id: 'submission', provider: 'claude', status, timings: { submitted: 1 } }
      }))
      restart()
      loadReadyPaneDrafts('account-a')
      expect(read()?.drafts.claude.text).toBe('Keep me')
      expect(read()?.submission?.status).toBe(
        status === 'starting' ? 'uncertain' : status === 'validating' ? 'failed' : status
      )
      expect(readySubmissionInFlight(read()?.submission)).toBe(
        status === 'starting' || status === 'uncertain'
      )
    }
  )
  it('requires the exact submission and delivery receipt before clearing only the sent provider', () => {
    updateReadyPane('account-a', 'ready', (pane) => ({
      ...pane,
      drafts: { claude: { text: 'Sent' }, codex: { text: 'Unsent' } },
      submission: {
        id: 'submission',
        provider: 'claude',
        status: 'starting',
        timings: { submitted: 1 }
      }
    }))
    expect(finishReadySubmission('account-a', 'ready', 'submission')).toBe(false)
    updateReadySubmission('account-a', 'ready', 'wrong', { delivered: true })
    expect(read()?.submission?.delivered).toBeUndefined()
    updateReadySubmission('account-a', 'ready', 'submission', { delivered: true })
    expect(finishReadySubmission('account-a', 'ready', 'submission')).toBe(true)
    expect(read()?.drafts.claude.text).toBe('')
    expect(read()?.drafts.codex.text).toBe('Unsent')
    expect(useReadyPaneDrafts.getState().documents['account-a'].traces[0]).toMatchObject({
      id: 'submission',
      status: 'attached',
      delivered: true
    })
    expect(
      JSON.stringify(useReadyPaneDrafts.getState().documents['account-a'].traces)
    ).not.toContain('Sent')
  })
  it('preserves an unsupported stored document and disables writes', () => {
    const raw = JSON.stringify({ version: 2, panes: { future: 'opaque' } })
    localStorage.setItem('omni.ready-panes.v1:account-a', raw)
    loadReadyPaneDrafts('account-a')
    expect(useReadyPaneDrafts.getState().errors['account-a']).toContain('preserved')
    expect(updateReadyPane('account-a', 'ready', (value) => value)).toBe(false)
    expect(localStorage.getItem('omni.ready-panes.v1:account-a')).toBe(raw)
  })
  it('blocks Send when persistence fails and keeps the previous saved draft', () => {
    updateReadyPane('account-a', 'ready', (pane) => ({
      ...pane,
      drafts: { ...pane.drafts, claude: { text: 'Saved' } }
    }))
    const storage = localStorage
    vi.stubGlobal('localStorage', {
      getItem: storage.getItem.bind(storage),
      setItem: () => {
        throw new Error('full')
      }
    })
    expect(
      updateReadyPane('account-a', 'ready', (pane) => ({
        ...pane,
        submission: {
          id: 'submission',
          provider: 'claude',
          status: 'starting',
          timings: { submitted: 1 }
        }
      }))
    ).toBe(false)
    expect(read()?.drafts.claude.text).toBe('Saved')
    expect(read()?.submission).toBeUndefined()
    expect(useReadyPaneDrafts.getState().errors['account-a']).toContain('disabled')
  })
})
