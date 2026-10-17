import { expect, it, vi } from 'vitest'
import { attachSessionToTask } from './create-task-submit'
import { workPlanCardAttachment } from './work-plan-card-attachment'

vi.mock('./create-task-submit', () => ({ attachSessionToTask: vi.fn() }))

it('delegates to the existing session attach path and preserves its refusal', async () => {
  const session = { label: 'Launch', agent: 'claude' as const, paneKey: 'pane-1' }
  const input = { cwd: '/workspace/launch' }
  const refused = {
    attached: false,
    sessionId: null,
    ledgerLinked: false,
    errorCode: 'session_not_found'
  }
  vi.mocked(attachSessionToTask).mockResolvedValue(refused)
  expect(await workPlanCardAttachment(session, input)('btk_launch01')).toBe(refused)
  expect(attachSessionToTask).toHaveBeenCalledWith(session, 'btk_launch01', input)
})
