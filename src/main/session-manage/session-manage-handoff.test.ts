import { describe, expect, it } from 'vitest'
import { contextualApprovalOf } from './session-manage-approval'
import type { AskWaitResult } from './session-manage-ask-wait'
import { handoffSession } from './session-manage-handoff'
import { agentProcess } from './session-manage-test-fixtures'
import { SessionManagePartialError } from './session-manage-refusal'
import { transferBrief } from './session-manage-transfer'
import { transferFixture, transferSession } from './session-manage-transfer-fixtures'
import type { SessionTransferInput } from './session-manage-transfer-contract'

const actor = { kind: 'pane' as const, paneKey: 'actor', title: 'Coordinator' }
const source = transferSession('source')
const input: SessionTransferInput = { actor, sources: [source], target: 'new', dryRun: false }

describe('session handoff', () => {
  it('creates and files the same-kind target and archives only after its acknowledgement', async () => {
    const { deps, events, target } = transferFixture()
    let acknowledge!: (reply: AskWaitResult) => void
    const acknowledgement = new Promise<AskWaitResult>((resolve) => {
      acknowledge = resolve
    })
    let deliveryStarted!: () => void
    const delivered = new Promise<void>((resolve) => {
      deliveryStarted = resolve
    })
    deps.deliver.mockImplementationOnce(async () => {
      deliveryStarted()
      return { sent: 'brief', wait: acknowledgement, acknowledgement: 'Accepted transfer fixture' }
    })
    const pending = handoffSession(deps, { ...input, note: 'Focus on syntax.' })
    await delivered
    expect(deps.archive).not.toHaveBeenCalled()
    acknowledge({
      outcome: 'answered',
      reply: 'Accepted transfer fixture'
    })
    const result = await pending
    expect(result).toMatchObject({ outcome: 'completed', archived: [{ paneKey: 'source' }] })
    expect(deps.create).toHaveBeenCalledWith(source, 'source (continued)')
    expect(deps.file).toHaveBeenCalledWith(expect.anything(), source)
    expect(deps.deliver.mock.calls[0]?.[1]).toContain('Focus on syntax.')
    expect(events.indexOf('audit:session.acknowledge')).toBeLessThan(events.indexOf('archive'))
    expect(deps.archive).toHaveBeenCalledWith(
      [source],
      'handed off to source (continued)',
      expect.any(Function),
      { ...target, entry: { ...target.entry, title: 'source (continued)' } }
    )
  })

  it('archives nothing on an ask timeout and records the queued ask and final failure', async () => {
    const { deps } = transferFixture()
    deps.ask.mockResolvedValueOnce({
      sent: 'question',
      wait: Promise.resolve({ outcome: 'timeout', question: 'delivered' })
    })
    const result = await handoffSession(deps, input)
    expect(result).toMatchObject({ outcome: 'failed', failedStep: 'ask source', archived: [] })
    expect(deps.archive).not.toHaveBeenCalled()
    expect(deps.create).not.toHaveBeenCalled()
    expect(deps.audit.mock.calls.map(([record]) => record.action)).toEqual(['ask', 'handoff'])
  })

  it('preserves the sent brief when acknowledgement times out', async () => {
    const { deps, target } = transferFixture()
    deps.deliver.mockResolvedValueOnce({
      sent: 'brief',
      wait: Promise.resolve({ outcome: 'timeout', question: 'delivered' })
    })
    const result = await handoffSession(deps, { ...input, target })
    expect(result).toMatchObject({
      outcome: 'failed',
      briefSent: true,
      failedStep: 'acknowledgement'
    })
    expect(result.summary).toContain('stays sent')
    expect(deps.archive).not.toHaveBeenCalled()
  })

  it('archives nothing when continue refuses the brief', async () => {
    const { deps, target } = transferFixture()
    deps.deliver.mockRejectedValueOnce(new Error('Refused (hard stop: deploy)'))
    const result = await handoffSession(deps, { ...input, target })
    expect(result).toMatchObject({
      outcome: 'failed',
      failedStep: 'deliver brief',
      briefSent: false
    })
    expect(deps.archive).not.toHaveBeenCalled()
  })

  it('does not treat an explicit target refusal as acknowledgement', async () => {
    const { deps, target } = transferFixture()
    deps.deliver.mockResolvedValueOnce({
      sent: 'brief',
      wait: Promise.resolve({ outcome: 'answered', reply: 'I cannot take over this work.' })
    })
    expect(await handoffSession(deps, { ...input, target })).toMatchObject({
      outcome: 'failed',
      failedStep: 'acknowledgement'
    })
    expect(deps.archive).not.toHaveBeenCalled()
  })

  it.each(['working', 'awaiting-user', 'unknown'] as const)(
    'refuses a %s source before any change',
    async (state) => {
      const { deps } = transferFixture()
      const result = await handoffSession(deps, {
        ...input,
        sources: [transferSession('source', { state })]
      })
      expect(result).toMatchObject({ outcome: 'failed', failedStep: 'validate' })
      expect(result.failure).toContain(state)
      for (const dependency of Object.values(deps)) {
        expect(dependency).not.toHaveBeenCalled()
      }
    }
  )

  it.each([
    ['an SSH source', { hostId: 'ssh:build-box' }, 'SSH host'],
    ['a source whose agent is not in the foreground', { agentForeground: false }, 'proven'],
    ['an exited source', { verdict: 'exited' as const }, 'exited']
  ])('refuses %s before any change', async (_name, overrides, words) => {
    const { deps } = transferFixture()
    const result = await handoffSession(deps, {
      ...input,
      sources: [transferSession('source', overrides)]
    })
    expect(result).toMatchObject({ outcome: 'failed', failedStep: 'validate', archived: [] })
    expect(result.failure).toContain(words)
    for (const dependency of Object.values(deps)) {
      expect(dependency).not.toHaveBeenCalled()
    }
  })

  it('refuses a source without the agent-process proof before any change', async () => {
    const { deps } = transferFixture()
    const result = await handoffSession(deps, {
      ...input,
      sources: [{ ...transferSession('source'), agentProcess: null }]
    })
    expect(result).toMatchObject({ outcome: 'failed', failedStep: 'validate' })
    expect(deps.ask).not.toHaveBeenCalled()
  })

  it('audits a partly applied delivery and archives nothing', async () => {
    const { deps, target } = transferFixture()
    deps.deliver.mockRejectedValueOnce(
      new SessionManagePartialError('The queue refused it.', 'its Keep going was turned off')
    )
    const result = await handoffSession(deps, { ...input, target })
    expect(result).toMatchObject({
      outcome: 'failed',
      failedStep: 'deliver brief',
      briefSent: false
    })
    expect(deps.archive).not.toHaveBeenCalled()
    const partial = deps.audit.mock.calls
      .map(([record]) => record)
      .find((record) => record.summary.startsWith('Partly applied'))
    expect(partial).toMatchObject({
      action: 'continue',
      target,
      after: { applied: 'its Keep going was turned off', completed: false }
    })
    expect(result.applied?.at(-1)).toContain('Partly applied')
    expect(result.summary).toContain('Changed so far')
    expect(deps.audit.mock.calls.at(-1)?.[0].action).toBe('handoff')
  })

  it('never makes a brief read as a bare approval of the target’s own proposal', () => {
    for (const words of ['yes', 'ok', '2', 'go ahead', 'do it', 'both']) {
      const sources = [transferSession(words), transferSession(`${words} too`)]
      expect(contextualApprovalOf(transferBrief('handoff', sources, [words], words))).toBeNull()
      expect(contextualApprovalOf(transferBrief('consolidate', sources, [words, words]))).toBeNull()
    }
  })

  it('dry-run lists steps and calls no dependencies', async () => {
    const { deps } = transferFixture()
    const result = await handoffSession(deps, { ...input, dryRun: true })
    expect(result).toMatchObject({ outcome: 'planned', target: { title: 'new' }, archived: [] })
    expect(result.steps).toHaveLength(6)
    expect(result.steps?.at(-2)).toBe('Point anything waiting on a source at the target.')
    for (const dependency of Object.values(deps)) {
      expect(dependency).not.toHaveBeenCalled()
    }
  })

  it('audits every applied step and final handoff with the actor', async () => {
    const { deps } = transferFixture()
    await handoffSession(deps, input)
    const records = deps.audit.mock.calls.map(([record]) => record)
    expect(records.map((record) => record.action)).toEqual([
      'ask',
      'session.create',
      'session.move',
      'continue',
      'session.acknowledge',
      'session.archive',
      'handoff'
    ])
    expect(records.every((record) => record.actor === actor)).toBe(true)
    expect(records.find((record) => record.action === 'session.archive')?.reason).toBe(
      'handed off to source (continued)'
    )
  })

  it('rechecks sources before archiving and leaves changed sources alone', async () => {
    const { deps, target } = transferFixture()
    deps.refresh.mockImplementation(async (session) =>
      deps.deliver.mock.calls.length && session === source
        ? transferSession('source', { state: 'working' })
        : session
    )
    expect(await handoffSession(deps, { ...input, target })).toMatchObject({
      outcome: 'failed',
      failedStep: 'archive sources',
      briefSent: true
    })
    expect(deps.archive).not.toHaveBeenCalled()
  })
  it('reports audit failure as a warning after an applied archive', async () => {
    const { deps } = transferFixture()
    deps.audit.mockRejectedValueOnce(new Error('disk unavailable'))
    const result = await handoffSession(deps, input)
    expect(result).toMatchObject({ outcome: 'completed', archived: [{ paneKey: 'source' }] })
    expect(result.auditError).toContain('disk unavailable')
    expect(deps.audit.mock.calls.at(-1)?.[0].action).toBe('handoff')
  })
  it.each([
    'No',
    'What should I do?',
    'I might continue later.',
    'Accepted transfer other',
    'Accepted transfer fixture\nI cannot accept responsibility.',
    'Accepted transfer fixture\nI have it but cannot continue.',
    'The prompt says "Accepted transfer fixture".'
  ])('does not archive on a non-acknowledgement: %s', async (reply) => {
    const { deps, target } = transferFixture()
    deps.deliver.mockResolvedValueOnce({
      sent: 'brief',
      acknowledgement: 'Accepted transfer fixture',
      wait: Promise.resolve({ outcome: 'answered', reply })
    })
    expect(await handoffSession(deps, { ...input, target })).toMatchObject({
      outcome: 'failed',
      failedStep: 'acknowledgement',
      archived: []
    })
    expect(deps.archive).not.toHaveBeenCalled()
  })

  it('refuses a replacement source process before archiving', async () => {
    const { deps, target } = transferFixture()
    deps.refresh.mockImplementation(async (session) =>
      deps.deliver.mock.calls.length && session === source
        ? { ...session, agentProcess: agentProcess({ pid: 999 }) }
        : session
    )
    const result = await handoffSession(deps, { ...input, target })
    expect(result).toMatchObject({ outcome: 'failed', failedStep: 'archive sources' })
    expect(result.failure).toContain('changed its conversation or agent process')
    expect(deps.archive).not.toHaveBeenCalled()
  })

  it('reports a rejected pre-archive checkpoint as unchanged, not an uncertain mutation', async () => {
    const { deps, target } = transferFixture()
    deps.assertCheckpoints.mockImplementation((sessions) => {
      if (sessions.length > 1) {
        throw new Error('source moved before dispatch')
      }
    })
    const result = await handoffSession(deps, { ...input, target })
    expect(result).toMatchObject({ outcome: 'failed', failedStep: 'archive sources' })
    expect(deps.archive).not.toHaveBeenCalled()
    expect(result.archiveOutcome).toBeUndefined()
    expect(result.summary).toContain('No sources were archived')
    expect(result.summary).not.toContain('may already be archived')
  })

  it('reports an uncertain archive honestly instead of promising no archive happened', async () => {
    const { deps } = transferFixture()
    deps.archive.mockRejectedValueOnce(new Error('reply lost after request'))
    const result = await handoffSession(deps, input)
    expect(result).toMatchObject({ outcome: 'failed', archiveOutcome: 'unknown', briefSent: true })
    expect(result.summary).toContain('sources may already be archived')
    expect(result.summary).not.toContain('No sources were archived')
  })

  it('prevents simultaneous transfers involving a reserved source or target', async () => {
    const first = transferFixture()
    const second = transferFixture()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = first.deps.ask.getMockImplementation()!
    first.deps.ask.mockImplementationOnce(async (...args) => {
      await blocked
      return original(...args)
    })
    const running = handoffSession(first.deps, input)
    await Promise.resolve()
    const conflict = await handoffSession(second.deps, { ...input, target: second.target })
    expect(conflict).toMatchObject({ outcome: 'failed' })
    expect(conflict.failure).toContain('already owns')
    expect(second.deps.ask).not.toHaveBeenCalled()
    release()
    expect(await running).toMatchObject({ outcome: 'completed' })
  })
})
