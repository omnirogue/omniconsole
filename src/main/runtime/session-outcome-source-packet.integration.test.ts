import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import type { SessionOutcomeDefinition } from '../../shared/session-outcome-types'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'

type Fixture = ReturnType<typeof outcomeRuntimeFixture>
type SourceRead = { action: string; captured: string; bytes: Buffer }
type SourceFileManifest = { original: string; captured: string }
const fixtures: Fixture[] = []
const originalBytes = Buffer.from('Approved result: 17 café\r\nKeep this exact revision.\r\n')
const sourcePath = (workspace: string) => join(workspace, 'source-report.txt')
const finalReport = (workspace: string) =>
  `SOURCE-FINAL: Approval covers revision 17.\nRead the [finished report](${sourcePath(workspace)}).`

afterEach(async () => {
  for (const fixture of fixtures.splice(0).toReversed()) {
    await fixture.dispose()
  }
})

function sourceFileManifests(brief: string): SourceFileManifest[] {
  return brief
    .split('\n')
    .filter((line) => line.startsWith('{') && line.includes('"captured"'))
    .map((line) => JSON.parse(line) as SourceFileManifest)
}

/**
 * A round's reviewers and a person's independent outcomes now start in the same tick (6cdf0bf2a,
 * #291), so which sibling finishes first is not part of this contract. Compare reads by action.
 */
function byAction(entries: SourceRead[]): SourceRead[] {
  return [...entries].sort((left, right) => left.action.localeCompare(right.action))
}

function readSource(
  brief: string,
  workspace: string,
  action: string,
  report = finalReport(workspace)
): SourceRead {
  expect(brief).toContain(report)
  const manifests = sourceFileManifests(brief).filter(
    (file) => file.original === sourcePath(workspace)
  )
  expect(manifests).toHaveLength(1)
  const captured = manifests[0]!.captured
  expect(captured).not.toBe(sourcePath(workspace))
  const persisted = JSON.parse(readFileSync(join(workspace, '.omni', 'state.json'), 'utf8')) as {
    sessionChains: SessionChain[]
  }
  const saved = persisted.sessionChains.find((chain) => chain.id === 'chain')!
  const packet = saved.outcomeSet!.continuation.sourcePacket!
  expect(packet.summary).toBe(report)
  expect(packet.files.some((file) => file.path === captured)).toBe(true)
  const bytes = readFileSync(captured)
  expect(bytes).toEqual(originalBytes)
  return { action, captured, bytes }
}

function fixture(reads: SourceRead[], restoreFrom?: string): Fixture {
  const f = outcomeRuntimeFixture((brief, workspace) => {
    const action = /ACTION:(\w+)/.exec(brief)![1]!
    const result = readSource(brief, workspace, action)
    reads.push(result)
    writeFileSync(join(workspace, `successor-${action}.txt`), result.bytes)
    return { body: `SUCCESSOR-REPORT:${action}: Read the original pinned report.` }
  }, restoreFrom)
  fixtures.push(f)
  return f
}

function finishSource(f: Fixture, report = finalReport(f.workspace)): void {
  writeFileSync(sourcePath(f.workspace), originalBytes)
  vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
    state: 'done',
    lastAssistantMessage: report,
    interactivePrompt: null,
    stateStartedAt: 1,
    updatedAt: Date.now()
  })
}

function outcome(id: string, workspace: string): SessionOutcomeDefinition {
  return {
    id,
    title: `Continue source work: ${id}`,
    finish: 'complete',
    dependsOn: [],
    conditions: [{ id: 'file', kind: 'file', target: join(workspace, `successor-${id}.txt`) }],
    actions: [
      {
        id: `continue_${id}`,
        instruction: `ACTION:${id}\nRead the original source report and preserve its exact bytes in successor-${id}.txt.`,
        agent: 'codex',
        authority: 'existing-user-authority',
        conditionIds: ['file']
      }
    ]
  }
}

function chain(workspace: string, steps: SessionChainAgentStep[] = []): SessionChain {
  return {
    id: 'chain',
    workspacePath: workspace,
    worktreeId: 'folder:outcome',
    hostId: 'local',
    sourcePaneKey: 'source',
    sourceRowKey: 'row',
    auto: true,
    steps,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  }
}

async function commit(f: Fixture, ids = ['one']) {
  const saved = await f.service.commit(chain(f.workspace), {
    expectedRevision: 0,
    source: 'user',
    outcomes: ids.map((id) => outcome(id, f.workspace))
  })
  f.service.dispose()
  expect(f.launched).toHaveLength(0)
  return saved
}

async function drain(f: Fixture): Promise<void> {
  for (let index = 0; index < 6; index++) {
    await f.service.tick()
    await f.settle()
  }
}

async function reviewFixture(mutateOriginal = false) {
  const reads: SourceRead[] = []
  const f = outcomeRuntimeFixture((brief, workspace) => {
    const reviewer = /STEP:(\w+)/.exec(brief)![1]!
    reads.push(readSource(brief, workspace, reviewer))
    if (mutateOriginal && reviewer === 'review_a') {
      writeFileSync(sourcePath(workspace), 'The first reviewer changed the original candidate.')
    }
    return {
      body: `OMNI_REVIEW_RESULT:${JSON.stringify({
        status: 'pass',
        blockingFindings: [],
        notes: `Read the retained source report as ${reviewer}.`
      })}`
    }
  })
  fixtures.push(f)
  finishSource(f)
  const reviewers: SessionChainAgentStep[] = ['review_a', 'review_b'].map((id) => ({
    id,
    outcomeId: 'review',
    agent: 'codex',
    prompt: `STEP:${id}\nReview the original source report.`,
    status: 'queued',
    group: 'review_round_1',
    review: {
      groupId: 'source_review',
      reviewerId: id,
      round: 1,
      maxRounds: 1,
      candidateVersion: 'unbound'
    }
  }))
  const saved = await f.service.commit(chain(f.workspace, reviewers), {
    expectedRevision: 0,
    source: 'user',
    outcomes: [
      {
        id: 'review',
        title: 'Review the completed source report',
        finish: 'complete',
        dependsOn: [],
        stepIds: reviewers.map((step) => step.id),
        actions: [],
        conditions: reviewers.map((step) => ({
          id: `report_${step.id}`,
          kind: 'report',
          target: step.id
        }))
      }
    ]
  })
  f.service.dispose()
  return { f, reads, packet: saved.outcomeSet!.continuation.sourcePacket! }
}

describe('original source context through durable outcome RPC execution', () => {
  it('captures at commit and restores the final report and pinned bytes after the source pane is gone', async () => {
    const reads: SourceRead[] = []
    const f = fixture(reads)
    finishSource(f)
    const saved = await commit(f)
    const packet = saved.outcomeSet!.continuation.sourcePacket!
    expect(packet).toMatchObject({
      sourceVersion: saved.outcomeSet!.continuation.sourceVersion,
      sourcePaneKey: 'source',
      sourceWorktreeId: 'folder:outcome',
      sourceHandle: 'source',
      processIncarnation: 'test:source:1',
      summaryKind: 'agent-response',
      summary: finalReport(f.workspace),
      missingFiles: [],
      files: [
        {
          sourcePath: sourcePath(f.workspace),
          name: 'source-report.txt',
          sha256: createHash('sha256').update(originalBytes).digest('hex'),
          size: originalBytes.length
        }
      ]
    })
    expect(packet.capturedAt).toBeGreaterThan(0)
    expect(packet.files).toHaveLength(1)
    expect(readFileSync(packet.files[0]!.path)).toEqual(originalBytes)
    await f.service.suspend()
    f.closeDatabase()
    writeFileSync(sourcePath(f.workspace), 'A later edit must never replace the captured report.')

    const restored = fixture(reads, f.workspace)
    vi.mocked(restored.runtime.resolveTerminalPane).mockImplementation(() => {
      throw new Error('The source pane has been closed.')
    })
    vi.mocked(restored.runtime.getFreshAgentHookStatusForHandle).mockReturnValue(null)
    expect(restored.service.get('chain').outcomeSet!.continuation.sourcePacket).toEqual(packet)
    await drain(restored)

    expect(reads).toEqual([
      { action: 'one', captured: packet.files[0]!.path, bytes: originalBytes }
    ])
    expect(readFileSync(join(restored.workspace, 'successor-one.txt'))).toEqual(originalBytes)
    expect(f.launched).toHaveLength(0)
    expect(restored.launched).toHaveLength(1)
    expect(sessionOutcomeProgress(restored.service.get('chain').outcomeSet!)).toMatchObject({
      lifecycle: 'complete',
      satisfied: 1,
      total: 1
    })
    expect(restored.service.get('chain').outcomeSet!.attempts[0]).toMatchObject({
      state: 'completed',
      taskId: expect.any(String),
      dispatchId: expect.any(String)
    })
  })

  it('gives independent first successors the same original packet after a sibling report and source edits', async () => {
    const reads: SourceRead[] = []
    const f = fixture(reads)
    // One agent at a time (6cdf0bf2a, #291, made a person's independent outcomes run side by side),
    // so the source edit below still lands between the two successors, which is what is under test.
    vi.spyOn(f.runtime, 'getOutcomeChainMaxConcurrentAgents').mockReturnValue(1)
    finishSource(f)
    const saved = await commit(f, ['one', 'two'])
    const packet = saved.outcomeSet!.continuation.sourcePacket!
    await f.service.tick()
    await f.settleReports()
    expect(f.launched).toHaveLength(1)
    writeFileSync(sourcePath(f.workspace), 'Source content changed after the first successor.')
    vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
      state: 'done',
      lastAssistantMessage: 'A later source response must not replace the original final report.',
      interactivePrompt: null,
      stateStartedAt: 2,
      updatedAt: Date.now()
    })
    await drain(f)

    expect(reads).toEqual([
      { action: 'one', captured: packet.files[0]!.path, bytes: originalBytes },
      { action: 'two', captured: packet.files[0]!.path, bytes: originalBytes }
    ])
    expect(f.launched).toHaveLength(2)
    expect(f.service.get('chain').outcomeSet!.continuation.sourcePacket).toEqual(packet)
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!)).toMatchObject({
      lifecycle: 'complete',
      satisfied: 2,
      total: 2
    })
  })

  it('blocks successor dispatch when captured file bytes change without changing their size', async () => {
    const reads: SourceRead[] = []
    const f = fixture(reads)
    finishSource(f)
    const saved = await commit(f)
    const packet = saved.outcomeSet!.continuation.sourcePacket!
    const tampered = Buffer.from(originalBytes)
    tampered[0] = 'X'.charCodeAt(0)
    writeFileSync(packet.files[0]!.path, tampered)
    expect(readFileSync(sourcePath(f.workspace))).toEqual(originalBytes)
    await drain(f)

    expect(reads).toEqual([])
    expect(f.launched).toHaveLength(0)
    expect(f.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    const state = f.service.get('chain').outcomeSet!
    const progress = sessionOutcomeProgress(state)
    // Bytes that changed under a pinned packet stop the launch: the host retries it and then fails
    // honestly. Nothing here is a question, so nobody is asked anything.
    expect(progress.attention).toEqual([])
    expect(['recovering', 'failed']).toContain(progress.phase)
    expect(progress.reasons.join('\n')).toMatch(/source|captur|integrity|hash|digest/i)
    expect(state.attempts.every((attempt) => !attempt.dispatchId)).toBe(true)
    expect(state.continuation.sourcePacket).toEqual(packet)
    expect(readFileSync(packet.files[0]!.path)).toEqual(tampered)
  })

  it('waits for a working source, then durably captures its completed report before the first worker reads it', async () => {
    const reads: SourceRead[] = []
    const f = fixture(reads)
    writeFileSync(sourcePath(f.workspace), 'An unfinished draft must not become successor input.')
    vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
      state: 'working',
      lastAssistantMessage: 'Still writing the source report.',
      interactivePrompt: null,
      stateStartedAt: 1,
      updatedAt: Date.now()
    })
    const saved = await commit(f)
    expect(saved.outcomeSet!.continuation.sourceReady).not.toBe(true)
    expect(saved.outcomeSet!.continuation.sourcePacket).toBeUndefined()
    await f.service.tick()
    expect(f.launched).toHaveLength(0)
    expect(f.service.get('chain').outcomeSet!.continuation.sourcePacket).toBeUndefined()

    finishSource(f)
    await f.service.tick()
    const packet = f.service.get('chain').outcomeSet!.continuation.sourcePacket!
    expect(packet.summary).toBe(finalReport(f.workspace))
    expect(packet.files).toHaveLength(1)
    await f.settleReports()
    expect(reads).toEqual([
      { action: 'one', captured: packet.files[0]!.path, bytes: originalBytes }
    ])
    await drain(f)

    expect(f.launched).toHaveLength(1)
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
  })

  it('blocks source capture when the saved working source process has been replaced', async () => {
    const reads: SourceRead[] = []
    const f = fixture(reads)
    vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
      state: 'working',
      lastAssistantMessage: null,
      interactivePrompt: null,
      stateStartedAt: 1,
      updatedAt: Date.now()
    })
    const saved = await commit(f)
    expect(saved.outcomeSet!.continuation.sourceBinding?.processIncarnation).toBe('test:source:1')
    vi.mocked(f.runtime.getTerminalProcessIncarnation).mockImplementation(
      (handle) => `test:${handle}:2`
    )
    finishSource(f)
    await drain(f)

    const state = f.service.get('chain').outcomeSet!
    expect(state.continuation.sourcePacket).toBeUndefined()
    expect(sessionOutcomeProgress(state)).toMatchObject({ phase: 'recovering', attention: [] })
    expect(sessionOutcomeProgress(state).reasons.join('\n')).toContain('source process changed')
    expect(reads).toEqual([])
    expect(f.launched).toHaveLength(0)
    expect(f.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('completes two folder reviewers using source report files when the outcome requires only review reports', async () => {
    const { f, reads, packet } = await reviewFixture()
    await drain(f)

    expect(byAction(reads)).toEqual([
      { action: 'review_a', captured: packet.files[0]!.path, bytes: originalBytes },
      { action: 'review_b', captured: packet.files[0]!.path, bytes: originalBytes }
    ])
    const saved = f.service.get('chain')
    const outcome = saved.outcomeSet!.outcomes[0]!
    expect(outcome.conditions.map((condition) => condition.kind)).toEqual(['report', 'report'])
    expect(outcome.evidence.map((evidence) => evidence.conditionId).sort()).toEqual([
      'report_review_a',
      'report_review_b'
    ])
    expect(sessionOutcomeProgress(saved.outcomeSet!).lifecycle).toBe('complete')
    const group = saved.reviewLoop!.groups[0]!
    // e65e00002 (#283) moved the all-pass check ahead of the review-only check in
    // sessionReviewRoundDecision, so a unanimous report-only round now passes.
    expect(group.status).toBe('passed')
    expect(group.rounds).toHaveLength(1)
    expect(group.rounds[0]!.receipts).toEqual([
      expect.objectContaining({
        reviewerId: 'review_a',
        status: 'pass',
        candidateVersion: group.rounds[0]!.candidateVersion
      }),
      expect.objectContaining({
        reviewerId: 'review_b',
        status: 'pass',
        candidateVersion: group.rounds[0]!.candidateVersion
      })
    ])
    expect(f.launched).toHaveLength(2)
  })

  it('rejects report-only review acceptance when a reviewer changes the original source file', async () => {
    const { f, reads, packet } = await reviewFixture(true)
    await drain(f)

    expect(byAction(reads)).toEqual([
      { action: 'review_a', captured: packet.files[0]!.path, bytes: originalBytes },
      { action: 'review_b', captured: packet.files[0]!.path, bytes: originalBytes }
    ])
    expect(f.launched).toHaveLength(2)
    expect(readFileSync(packet.files[0]!.path)).toEqual(originalBytes)
    expect(readFileSync(sourcePath(f.workspace))).not.toEqual(originalBytes)
    const saved = f.service.get('chain')
    const progress = sessionOutcomeProgress(saved.outcomeSet!)
    // Reviewers judged bytes that moved: an honest failure, and nothing a person is asked for.
    expect(progress).toMatchObject({ phase: 'failed', attention: [] })
    expect(saved.outcomeSet!.outcomes[0]!.block).toMatchObject({
      class: 'failed',
      code: 'review-candidate-changed'
    })
    expect(progress.reasons.join('\n')).toContain('candidate changed during review')
    expect(saved.outcomeSet!.outcomes[0]!.evidence).toEqual([])
  })

  it('passes unnamed modified and untracked source files to the worker without including secret or runtime files', async () => {
    const expected = new Map([
      ['unnamed-modified.txt', Buffer.from('Exact modified source bytes\r\n')],
      ['unnamed-untracked.txt', Buffer.from('Exact new source bytes: café\r\n')]
    ])
    const received: string[] = []
    const f = outcomeRuntimeFixture((brief, workspace) => {
      const report = readSource(brief, workspace, 'one')
      const manifests = sourceFileManifests(brief)
      expect(manifests.map((file) => file.original).sort()).toEqual(
        [sourcePath(workspace), ...[...expected.keys()].map((name) => join(workspace, name))].sort()
      )
      for (const [name, bytes] of expected) {
        const file = manifests.find((entry) => entry.original === join(workspace, name))!
        expect(readFileSync(file.captured)).toEqual(bytes)
        received.push(name)
      }
      writeFileSync(join(workspace, 'successor-one.txt'), report.bytes)
      return { body: 'Read the source report and its unnamed workspace changes.' }
    })
    fixtures.push(f)
    finishSource(f)
    for (const [name, bytes] of expected) {
      writeFileSync(join(f.workspace, name), bytes)
    }
    f.write('.env', 'NOT-FOR-THE-SOURCE-PACKET')
    f.write('.omni/internal.txt', 'Runtime metadata must remain outside the packet.')
    vi.spyOn(f.runtime, 'getRuntimeGitStatus').mockResolvedValue({
      conflictOperation: 'unknown',
      entries: [
        { path: 'unnamed-modified.txt', status: 'modified', area: 'unstaged' },
        { path: 'unnamed-untracked.txt', status: 'untracked', area: 'untracked' },
        { path: '.env', status: 'untracked', area: 'untracked' },
        { path: '.omni/internal.txt', status: 'untracked', area: 'untracked' }
      ]
    })
    const saved = await commit(f)
    expect(saved.outcomeSet!.continuation.sourcePacket!.files).toHaveLength(3)
    for (const name of expected.keys()) {
      f.write(name, 'A later edit must not replace the retained Git-status input.')
    }
    await drain(f)

    expect(received).toEqual([...expected.keys()])
    expect(f.launched).toHaveLength(1)
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
  })

  it('blocks a completed source report exceeding 100,000 characters before capturing or launching', async () => {
    const reads: SourceRead[] = []
    const f = fixture(reads)
    vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
      state: 'working',
      lastAssistantMessage: null,
      interactivePrompt: null,
      stateStartedAt: 1,
      updatedAt: Date.now()
    })
    const saved = await commit(f)
    expect(saved.outcomeSet!.continuation.sourcePacket).toBeUndefined()
    const report = `${'r'.repeat(100_001)}\n${finalReport(f.workspace)}`
    expect(report.length).toBeGreaterThan(100_000)
    finishSource(f, report)
    await drain(f)

    const state = f.service.get('chain').outcomeSet!
    const progress = sessionOutcomeProgress(state)
    // A refused capture is tried again by the host; it never asks a person for anything.
    expect(progress).toMatchObject({ phase: 'recovering', attention: [] })
    expect(progress.reasons.join('\n')).toMatch(/100[,_ ]?000/)
    expect(state.continuation.sourcePacket).toBeUndefined()
    expect(readFileSync(sourcePath(f.workspace))).toEqual(originalBytes)
    expect(reads).toEqual([])
    expect(f.launched).toHaveLength(0)
    expect(f.runtime.createTerminal).not.toHaveBeenCalled()
    expect(f.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('persists an actionable capture refusal when an already-finished source report exceeds the launch limit', async () => {
    const reads: SourceRead[] = []
    const f = fixture(reads)
    finishSource(f, 'x'.repeat(100_001))
    const saved = await commit(f)
    expect(sessionOutcomeProgress(saved.outcomeSet!)).toMatchObject({
      phase: 'recovering',
      attention: []
    })
    expect(saved.outcomeSet!.outcomes[0]!.blockedReason).toContain('workspace file')
    expect(saved.outcomeSet!.continuation.sourcePacket).toBeUndefined()
    expect(readFileSync(sourcePath(f.workspace))).toEqual(originalBytes)
    expect(f.runtime.createTerminal).not.toHaveBeenCalled()
  })

  it.each([{ truncated: true }, { limited: true }])(
    'refuses incomplete terminal source output: %j',
    async (flags) => {
      const reads: SourceRead[] = []
      const f = fixture(reads)
      finishSource(f)
      vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
        state: 'done',
        lastAssistantMessage: null,
        interactivePrompt: null,
        stateStartedAt: 1,
        updatedAt: Date.now()
      })
      vi.spyOn(f.runtime, 'readTerminal').mockResolvedValue({
        handle: 'source',
        status: 'exited',
        tail: ['Only the last retained source lines'],
        truncated: false,
        nextCursor: null,
        ...flags
      })
      const saved = await commit(f)
      expect(sessionOutcomeProgress(saved.outcomeSet!)).toMatchObject({
        phase: 'recovering',
        attention: []
      })
      expect(saved.outcomeSet!.outcomes[0]!.blockedReason).toContain(
        'source terminal output is incomplete'
      )
      expect(saved.outcomeSet!.continuation.sourcePacket).toBeUndefined()
      expect(readFileSync(sourcePath(f.workspace))).toEqual(originalBytes)
      expect(f.runtime.createTerminal).not.toHaveBeenCalled()
    }
  )

  it('retains a complete multibyte source report longer than 32,000 characters without a separate UTF-8 byte cap', async () => {
    const reportFor = (workspace: string) =>
      `SOURCE-BEGIN: Preserve the first instruction.\n${'é'.repeat(40_000)}\n${finalReport(workspace)}\nSOURCE-END: Preserve the final instruction.`
    const reads: SourceRead[] = []
    const f = outcomeRuntimeFixture((brief, workspace) => {
      const result = readSource(brief, workspace, 'one', reportFor(workspace))
      reads.push(result)
      writeFileSync(join(workspace, 'successor-one.txt'), result.bytes)
      return { body: 'Read the entire source report including its first and last instructions.' }
    })
    fixtures.push(f)
    const report = reportFor(f.workspace)
    expect(report.length).toBeGreaterThan(32_000)
    expect(report.length).toBeLessThan(100_000)
    expect(Buffer.byteLength(report, 'utf8')).toBeGreaterThan(65_536)
    finishSource(f, report)
    const saved = await commit(f)
    const packet = saved.outcomeSet!.continuation.sourcePacket!
    expect(packet.summary).toBe(report)
    expect(packet.summary.startsWith('SOURCE-BEGIN:')).toBe(true)
    expect(packet.summary.endsWith('SOURCE-END: Preserve the final instruction.')).toBe(true)
    await drain(f)

    expect(reads).toEqual([
      { action: 'one', captured: packet.files[0]!.path, bytes: originalBytes }
    ])
    expect(f.launched).toHaveLength(1)
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
  })

  it('blocks a combined execution brief over 100,000 characters before creating a coordinator or worker', async () => {
    const reads: SourceRead[] = []
    const f = fixture(reads)
    const report = `${'r'.repeat(45_000)}\n${finalReport(f.workspace)}`
    finishSource(f, report)
    const definition = outcome('one', f.workspace)
    definition.actions[0]!.instruction += `\n${'a'.repeat(30_000)}`
    expect(report.length).toBeLessThan(100_000)
    expect(report.length + definition.actions[0]!.instruction.length * 2).toBeGreaterThan(100_000)
    const saved = await f.service.commit(chain(f.workspace), {
      expectedRevision: 0,
      source: 'user',
      outcomes: [definition]
    })
    f.service.dispose()
    const packet = saved.outcomeSet!.continuation.sourcePacket!
    expect(packet.summary).toBe(report)
    expect(readFileSync(packet.files[0]!.path)).toEqual(originalBytes)
    await drain(f)

    const state = f.service.get('chain').outcomeSet!
    const progress = sessionOutcomeProgress(state)
    // Only the person can shorten what they asked a stage to read: a genuine request.
    expect(progress).toMatchObject({ phase: 'needs-you', lifecycle: 'needs-you' })
    expect(progress.attention).toMatchObject([
      { kind: 'clarification', state: 'open', recipient: { type: 'owner' } }
    ])
    expect(progress.reasons.join('\n')).toMatch(/100[,_ ]?000/)
    expect(progress.reasons.join('\n')).toMatch(/source report/i)
    expect(progress.reasons.join('\n')).toMatch(/previous (?:step )?reports/i)
    expect(
      state.attempts.every((attempt) => !attempt.dispatchId && !attempt.coordinatorHandle)
    ).toBe(true)
    expect(state.continuation.sourcePacket).toEqual(packet)
    expect(readFileSync(packet.files[0]!.path)).toEqual(originalBytes)
    expect(readFileSync(sourcePath(f.workspace))).toEqual(originalBytes)
    expect(reads).toEqual([])
    expect(f.launched).toHaveLength(0)
    expect(f.runtime.createTerminal).not.toHaveBeenCalled()
    expect(f.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
})
