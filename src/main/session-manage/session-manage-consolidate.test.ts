import { describe, expect, it } from 'vitest'
import { consolidateSessions } from './session-manage-consolidate'
import type { SessionTransferInput } from './session-manage-transfer-contract'
import { transferFixture, transferSession } from './session-manage-transfer-fixtures'

const first = transferSession('first')
const second = transferSession('second', { state: 'waiting-for-yes' })
const busy = transferSession('busy', { state: 'working' })
const input: SessionTransferInput = {
  actor: { kind: 'cli' },
  sources: [first, second, busy],
  target: 'new',
  dryRun: false
}

describe('session consolidate', () => {
  it('refuses all sources when one is busy', async () => {
    const { deps } = transferFixture()
    const result = await consolidateSessions(deps, input)
    expect(result).toMatchObject({ outcome: 'failed', failedStep: 'validate' })
    expect(result.failure).toContain('busy')
    expect(deps.ask).not.toHaveBeenCalled()
    expect(deps.archive).not.toHaveBeenCalled()
  })

  it('skips busy sources, asks in order, merges summaries, and archives eligible sources together', async () => {
    const { deps, events, target } = transferFixture()
    const result = await consolidateSessions(deps, { ...input, skipBusy: true })
    expect(result).toMatchObject({ outcome: 'completed', skipped: [{ paneKey: 'busy' }] })
    expect(deps.ask.mock.calls.map(([source]) => source.entry.paneKey)).toEqual(['first', 'second'])
    expect(deps.create).toHaveBeenCalledWith(first, 'Consolidated: first +1')
    const prompt = deps.deliver.mock.calls[0]?.[1]
    expect(prompt).toContain('## first')
    expect(prompt).toContain('## second')
    expect(prompt).toContain('Where these summaries overlap or conflict, say so before acting.')
    expect(deps.archive).toHaveBeenCalledExactlyOnceWith(
      [first, second],
      'consolidated into Consolidated: first +1',
      expect.any(Function),
      { ...target, entry: { ...target.entry, title: 'Consolidated: first +1' } }
    )
    expect(events.indexOf('audit:session.acknowledge')).toBeLessThan(events.indexOf('archive'))
    expect(deps.audit.mock.calls.map(([record]) => record.action)).toEqual([
      'ask',
      'ask',
      'session.create',
      'session.move',
      'continue',
      'session.acknowledge',
      'session.archive',
      'session.archive',
      'consolidate'
    ])
  })

  it('requires at least two eligible sources even with skip-busy', async () => {
    const { deps } = transferFixture()
    expect(
      await consolidateSessions(deps, { ...input, sources: [first, busy], skipBusy: true })
    ).toMatchObject({ outcome: 'failed', skipped: [{ paneKey: 'busy' }] })
    expect(deps.ask).not.toHaveBeenCalled()
  })

  it('requires an idle target and refuses before asking', async () => {
    const { deps } = transferFixture()
    const target = transferSession('target', { state: 'waiting-for-yes' })
    expect(
      await consolidateSessions(deps, { ...input, sources: [first, second], target })
    ).toMatchObject({ outcome: 'failed', failedStep: 'validate' })
    expect(deps.ask).not.toHaveBeenCalled()
  })

  it('a later ask failure leaves every source unarchived', async () => {
    const { deps } = transferFixture()
    deps.ask.mockResolvedValueOnce({
      sent: 'first',
      wait: Promise.resolve({ outcome: 'answered', reply: 'First summary' })
    })
    deps.ask.mockResolvedValueOnce({
      sent: 'second',
      wait: Promise.resolve({ outcome: 'timeout', question: 'withdrawn' })
    })
    expect(await consolidateSessions(deps, { ...input, sources: [first, second] })).toMatchObject({
      outcome: 'failed',
      failedStep: 'ask second',
      archived: []
    })
    expect(deps.archive).not.toHaveBeenCalled()
    expect(deps.deliver).not.toHaveBeenCalled()
  })

  it('dry-run skips busy sources without calling any dependencies', async () => {
    const { deps } = transferFixture()
    expect(
      await consolidateSessions(deps, { ...input, skipBusy: true, dryRun: true })
    ).toMatchObject({ outcome: 'planned', skipped: [{ paneKey: 'busy' }] })
    for (const dependency of Object.values(deps)) {
      expect(dependency).not.toHaveBeenCalled()
    }
  })

  it('refuses duplicate sources and a target among the sources', async () => {
    const { deps } = transferFixture()
    for (const overrides of [
      { sources: [first, first] },
      { sources: [first, second], target: first }
    ]) {
      expect(await consolidateSessions(deps, { ...input, ...overrides })).toMatchObject({
        outcome: 'failed',
        failedStep: 'validate'
      })
    }
    expect(deps.ask).not.toHaveBeenCalled()
  })
})
