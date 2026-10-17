import { beforeEach, expect, it, vi } from 'vitest'
const dispatch = vi.hoisted(() => vi.fn())
const send = vi.hoisted(() => vi.fn())
const capture = vi.hoisted(() => vi.fn())
vi.mock('../backoffice/console-workflow-person', () => ({ captureConsoleWorkflowPerson: capture }))
vi.mock('../ipc/notifications', () => ({ dispatchAppNotification: dispatch }))
vi.mock('./hub-slack-client', () => ({ hubSlackClient: { send } }))
import { desktopRoutineDeliveryAdapters as adapters } from './routine-delivery-adapters'
import type { Automation, AutomationRun } from '../../shared/automations-types'
const automation = { id: 'a', name: 'Briefing' } as Automation
const run = { id: 'r' } as AutomationRun
beforeEach(() => {
  vi.clearAllMocks()
})
it('uses the existing native delivery path exactly once with a clickable run link', async () => {
  dispatch.mockResolvedValue({ delivered: true })
  await adapters.desktop('Ready', 'omni://automation/a/run/r', automation, run)
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      notificationId: 'routine:r',
      routineRunLink: 'omni://automation/a/run/r',
      requireDisplayConfirmation: true
    })
  )
})
it('posts Slack alert summary and run link without the full output', async () => {
  send.mockResolvedValue({ ok: true, permalink: 'https://slack.example/m' })
  await adapters.alert(
    { kind: 'slack-channel', channelId: 'C1', channelName: 'test' },
    'Ready',
    'omni://automation/a/run/r',
    automation,
    run
  )
  expect(send).toHaveBeenCalledExactlyOnceWith({
    kind: 'channel',
    channel: 'C1',
    text: 'Ready',
    runLink: 'omni://automation/a/run/r',
    automationId: 'a',
    runId: 'r',
    purpose: 'alert'
  })
})
it('surfaces native authorization failures and hub refusals to receipts', async () => {
  dispatch.mockResolvedValue({ delivered: false, reason: 'blocked-by-system' })
  await expect(adapters.desktop('Ready', '', automation, run)).rejects.toThrow('blocked-by-system')
  send.mockResolvedValue({ ok: false, error: 'No Slack connection' })
  await expect(adapters.alert({ kind: 'slack-dm' }, 'Ready', '', automation, run)).rejects.toThrow(
    'No Slack connection'
  )
})

it('keeps native notifications working when Slack credential refresh times out', async () => {
  vi.useFakeTimers()
  try {
    capture.mockImplementation(() => new Promise(() => {}))
    dispatch.mockResolvedValue({ delivered: true })
    const pending = adapters.prepare!()
    await vi.advanceTimersByTimeAsync(10_000)
    const prepared = await pending
    await prepared.desktop('Ready', 'omni://automation/a/run/r', automation, run)
    expect(dispatch).toHaveBeenCalledTimes(1)
    await expect(
      prepared.alert({ kind: 'slack-dm' }, 'Ready', 'omni://automation/a/run/r', automation, run)
    ).rejects.toThrow('10 seconds')
    expect(send).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('uses one captured person for every external destination in a completed run', async () => {
  const person = { principal: 'owner', isCurrent: () => true }
  capture.mockResolvedValue({ ok: true, data: person })
  send.mockResolvedValue({ ok: true })
  const prepared = await adapters.prepare!()
  capture.mockResolvedValue({ ok: true, data: { principal: 'different-person' } })
  await prepared.alert({ kind: 'slack-dm' }, 'Ready', 'omni://automation/a/run/r', automation, run)
  await prepared.deliver(
    { kind: 'slack', channel: 'C1' },
    'Output',
    'omni://automation/a/run/r',
    automation,
    run
  )
  expect(capture).toHaveBeenCalledTimes(1)
  expect(send.mock.calls.map((call) => call[1])).toEqual([person, person])
})
