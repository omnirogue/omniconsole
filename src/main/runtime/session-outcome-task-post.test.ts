import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { outcomeTaskAttachmentAccess } from './session-outcome-task-post'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import { attachConsoleSession, ingestConsoleSession } from '../backoffice/console-session-task'
import { planReportChain } from '../../shared/__fixtures__/work-plan/plan-report-chain'
import type { OrcaRuntimeService } from './omni-runtime'

vi.mock('../backoffice/console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
vi.mock('../backoffice/console-session-task', () => ({
  attachConsoleSession: vi.fn(),
  ingestConsoleSession: vi.fn()
}))
const fetchMock = vi.fn<typeof fetch>()
const isCurrent = vi.fn(() => true)
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  isCurrent.mockReturnValue(true)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: { baseUrl: 'https://hub.invalid', bearer: 'test', principal: 'person', isCurrent }
  })
})
afterEach(() => vi.unstubAllGlobals())
function fixture() {
  const chain = planReportChain()
  const runtime = {
    listSessionChains: () => [chain],
    getSessionOutcomeTranscriptSource: () => undefined
  } as unknown as OrcaRuntimeService
  return { chain, runtime, access: () => outcomeTaskAttachmentAccess(runtime, chain) }
}

it('uses the existing main hub session operations and returns their refusal verbatim', async () => {
  const f = fixture()
  vi.mocked(ingestConsoleSession).mockResolvedValue({
    ok: true,
    data: { sessionId: 'ses_source1234' }
  })
  vi.mocked(attachConsoleSession).mockResolvedValue({
    ok: false,
    error: { code: 'invalid_request', message: 'Card is closed.' }
  })
  const access = await f.access()
  expect(await access.poster.attachSessionToTask('btk_card1234')).toEqual({
    attached: false,
    errorMessage: 'Card is closed.'
  })
  expect(ingestConsoleSession).toHaveBeenCalledWith(
    expect.objectContaining({ sessionRef: f.chain.sourcePaneKey, cwd: f.chain.workspacePath })
  )
  expect(attachConsoleSession).toHaveBeenCalledWith({
    sessionId: 'ses_source1234',
    taskId: 'btk_card1234'
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

it('posts the typed note and forwards an evidence 409 without reattribution', async () => {
  const f = fixture()
  const access = await f.access()
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'note1' })))
  expect(
    await access.poster.postNote(access.cardAccess, 'btk_card1234', {
      note: 'Progress',
      note_kind: 'progress',
      payload: {
        summary: 'Progress',
        done: [],
        next_action: 'verify',
        evidence: [],
        knowledge: [{ op: 'none', reason: 'No new knowledge' }]
      }
    })
  ).toEqual({ ok: true, data: { id: 'note1' } })
  expect(fetchMock.mock.calls[0]![0]).toBe(
    'https://hub.invalid/api/team/tasks/btk_card1234/comment'
  )
  const conflict = { detail: 'evidence_exists', task_id: 'btk_other1234' }
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(conflict), { status: 409 }))
  expect(
    await access.poster.postEvidence(access.cardAccess, 'btk_card1234', {
      kind: 'doc',
      ref: 'report',
      title: 'Report'
    })
  ).toEqual({ ok: false, reason: JSON.stringify(conflict) })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('refuses a changed person before any hub mutation', async () => {
  const f = fixture()
  const access = await f.access()
  isCurrent.mockReturnValue(false)
  expect(await access.poster.attachSessionToTask('btk_card1234')).toMatchObject({ attached: false })
  expect(ingestConsoleSession).not.toHaveBeenCalled()
  expect(fetchMock).not.toHaveBeenCalled()
})
