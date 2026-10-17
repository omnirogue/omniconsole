// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import {
  submitWorkObjectives,
  updateWorkObjectives,
  workObjectives,
  type WorkObjective
} from './work-objective-state'
import { readWorkObjectiveStorage } from './work-objective-storage'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const requestFor = (row: WorkObjective) => ({
  requestId: row.id,
  text: row.text.trim(),
  context: '',
  source: {
    worktreeId: 'local',
    paneKey: 'need-speed:profile:work',
    agent: 'codex',
    entryPoint: 'need-speed' as const,
    routingMode: 'shadow' as const
  },
  agentTemplateId: 'template-pinned'
})

it('preserves one objective per row and retries a lost response without repeating accepted rows', async () => {
  const pane = crypto.randomUUID()
  updateWorkObjectives(pane, () => ({
    sending: false,
    rows: [
      { id: 'a', text: 'Audit login' },
      { id: 'b', text: 'Plan the newsletter' }
    ]
  }))
  const prepare = vi.fn(async (row) => ({
    requestId: row.id,
    text: row.text,
    context: '',
    source: {
      worktreeId: 'local',
      paneKey: pane,
      agent: 'codex',
      entryPoint: 'need-speed' as const
    }
  }))
  const dispatch = vi
    .fn()
    .mockResolvedValueOnce({ batchId: 'batch-a' })
    .mockRejectedValueOnce(new Error('reply lost'))
  await submitWorkObjectives(pane, prepare, dispatch)
  expect(dispatch.mock.calls.map(([request]) => request.text)).toEqual([
    'Audit login',
    'Plan the newsletter'
  ])
  const lost = workObjectives(pane).rows[1].request
  expect(workObjectives(pane).rows[0].batchId).toBe('batch-a')
  dispatch.mockResolvedValueOnce({ batchId: 'batch-b' })
  await submitWorkObjectives(pane, prepare, dispatch)
  expect(dispatch).toHaveBeenCalledTimes(3)
  expect(dispatch.mock.calls[2][0]).toBe(lost)
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(workObjectives(pane).rows.map((row) => row.batchId)).toEqual(['batch-a', 'batch-b'])
})

it('ignores repeated submission while acceptance is pending', async () => {
  const pane = crypto.randomUUID()
  updateWorkObjectives(pane, () => ({ sending: false, rows: [{ id: 'a', text: 'Audit login' }] }))
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const prepare = vi.fn(async (row) => ({
    requestId: row.id,
    text: row.text,
    context: '',
    source: { worktreeId: 'local', paneKey: pane, agent: 'codex' }
  }))
  const dispatch = vi.fn(async () => {
    await waiting
    return { batchId: 'batch-a' }
  })
  const first = submitWorkObjectives(pane, prepare, dispatch)
  await submitWorkObjectives(pane, prepare, dispatch)
  release()
  await first
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it('restores accepted rows and the exact retry request after a renderer restart', async () => {
  const pane = JSON.stringify(['need-speed:profile:work', 'repo-a'])
  updateWorkObjectives(pane, () => ({
    sending: false,
    rows: [
      { id: 'accepted', text: 'Audit login' },
      { id: 'retry', text: '  Plan the newsletter  ' }
    ]
  }))
  const dispatch = vi.fn(async (request) => {
    expect(
      readWorkObjectiveStorage(pane)?.rows.find((row) => row.id === request.requestId)?.request
    ).toEqual(request)
    if (request.requestId === 'retry') {
      throw new Error('Reply lost after acceptance')
    }
    return { batchId: 'batch-accepted' }
  })
  await submitWorkObjectives(pane, async (row) => requestFor(row), dispatch)
  const frozen = workObjectives(pane).rows[1].request
  vi.resetModules()
  const restored = await import('./work-objective-state')
  expect(restored.workObjectives(pane).sending).toBe(false)
  expect(restored.workObjectives(pane).rows[0].batchId).toBe('batch-accepted')
  expect(restored.workObjectives(pane).rows[1].request).toEqual(frozen)
  expect(
    restored.workObjectives(JSON.stringify(['need-speed:other-profile:work', 'repo-a'])).rows[0]
      .text
  ).toBe('')
  expect(
    restored.workObjectives(JSON.stringify(['need-speed:profile:work', 'repo-b'])).rows[0].text
  ).toBe('')
  const prepare = vi.fn(async (row: WorkObjective) => requestFor(row))
  const retry = vi.fn(async () => ({ batchId: 'batch-retry' }))
  await restored.submitWorkObjectives(pane, prepare, retry)
  expect(prepare).not.toHaveBeenCalled()
  expect(retry).toHaveBeenCalledExactlyOnceWith(frozen)
  expect(restored.workObjectives(pane).rows.map((row) => row.batchId)).toEqual([
    'batch-accepted',
    'batch-retry'
  ])
})

it('restores an interrupted send as retryable without automatically sending it', async () => {
  const pane = crypto.randomUUID()
  updateWorkObjectives(pane, () => ({
    sending: false,
    rows: [{ id: 'interrupted', text: 'Audit' }]
  }))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const dispatch = vi.fn(async () => {
    await gate
    throw new Error('Renderer ended')
  })
  const pending = submitWorkObjectives(pane, async (row) => requestFor(row), dispatch)
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
  vi.resetModules()
  const restored = await import('./work-objective-state')
  expect(restored.workObjectives(pane)).toMatchObject({
    sending: false,
    rows: [{ id: 'interrupted', request: { requestId: 'interrupted' } }]
  })
  expect(restored.workObjectives(pane).rows[0].error).toContain('interrupted')
  expect(dispatch).toHaveBeenCalledTimes(1)
  release()
  await pending
})

it('refuses to send when the frozen request cannot be saved', async () => {
  const pane = crypto.randomUUID()
  updateWorkObjectives(pane, () => ({ sending: false, rows: [{ id: 'a', text: 'Audit' }] }))
  const storage = localStorage
  vi.stubGlobal('localStorage', {
    getItem: storage.getItem.bind(storage),
    removeItem: storage.removeItem.bind(storage),
    setItem: (key: string, value: string) => {
      if (JSON.parse(value).rows.some((row: WorkObjective) => row.request)) {
        throw new Error('Storage full')
      }
      storage.setItem(key, value)
    }
  })
  const dispatch = vi.fn(async () => ({ batchId: 'must-not-launch' }))
  await submitWorkObjectives(pane, async (row) => requestFor(row), dispatch)
  expect(dispatch).not.toHaveBeenCalled()
  expect(workObjectives(pane).sending).toBe(false)
  expect(workObjectives(pane).storageError).toContain('Could not save')
})

it('admits at most two independent row submissions and fills a free slot', async () => {
  const pane = crypto.randomUUID()
  updateWorkObjectives(pane, () => ({
    sending: false,
    rows: ['a', 'b', 'c', 'd'].map((id) => ({ id, text: id }))
  }))
  const releases = new Map<string, () => void>()
  let active = 0
  let peak = 0
  const dispatch = vi.fn(async (request) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise<void>((resolve) => {
      releases.set(request.requestId, resolve)
    })
    active -= 1
    return { batchId: request.requestId }
  })
  const pending = submitWorkObjectives(pane, async (row) => requestFor(row), dispatch)
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
  releases.get('b')!()
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(3))
  expect(releases.has('c')).toBe(true)
  releases.get('c')!()
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(4))
  releases.get('a')!()
  releases.get('d')!()
  await pending
  expect(peak).toBe(2)
  expect(workObjectives(pane).rows.map((row) => row.batchId)).toEqual(['a', 'b', 'c', 'd'])
})
