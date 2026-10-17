import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { compileNextStepChain } from '../../shared/next-step-compile'
import { compileNextStepOutcomes } from '../../shared/next-outcome-definition-compile'
import { emptyNextStepDraft, type NextStepDraft } from '../../shared/next-step-draft'
import {
  sessionChainStepOutputDir,
  type SessionChainAgentStep
} from '../../shared/session-chain-types'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { materializeSessionOutcomeSourceRepairs } from './session-outcome-source-repairs'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
})

it.each(['pass', 'findings', 'capped', 'unverified-source'] as const)(
  'respects three UI review rounds and source repair ownership for %s',
  async (firstVerdict) => {
    const phases: string[] = []
    const reports: { path: string; bytes: string; round: number }[] = []
    let sourceRepairs: SessionChainAgentStep[] = []
    const f = outcomeRuntimeFixture((spec, workspace) => {
      if (spec.startsWith('STEP:review')) {
        const round = Number(/Review group \S+, round (\d+) of at most 3/.exec(spec)![1])
        phases.push(`review-${round}`)
        const candidate = readFileSync(join(workspace, 'deliverable.txt'), 'utf8')
        expect(candidate).toBe(
          round === 1 ? 'Original candidate' : `Repaired candidate ${round - 1}`
        )
        const status = firstVerdict === 'capped' ? 'findings' : round === 1 ? firstVerdict : 'pass'
        const path = join(workspace, `review-${reports.length + 1}.md`)
        const bytes = `Reviewed candidate: ${candidate}`
        writeFileSync(path, bytes)
        reports.push({ path, bytes, round })
        return {
          body: [
            `REVIEW_FILE: ${path}`,
            `OMNI_REVIEW_RESULT:${JSON.stringify({
              status,
              blockingFindings: status === 'findings' ? ['Add the missing conclusion.'] : []
            })}`
          ].join('\n')
        }
      }
      if (spec.startsWith('Continue the original task using the completed source work.')) {
        phases.push('repair')
        const repairNumber = phases.filter((phase) => phase === 'repair').length
        expect(spec).toContain('Add the missing conclusion.')
        expect(reports).toHaveLength(repairNumber * 2)
        for (const report of reports) {
          expect(spec).toContain(`REVIEW_FILE: ${report.path}`)
          expect(readFileSync(report.path, 'utf8')).toBe(report.bytes)
        }
        writeFileSync(join(workspace, 'deliverable.txt'), `Repaired candidate ${repairNumber}`)
        const output = sessionChainStepOutputDir(
          workspace,
          'chain',
          sourceRepairs[repairNumber - 1]!.id
        )
        mkdirSync(output, { recursive: true })
        writeFileSync(join(output, 'manifest.md'), join(workspace, 'deliverable.txt'))
        return {
          body: `SOURCE_REPAIR_RECEIPT: Added the missing conclusion to deliverable.txt. Repair ${repairNumber}.`
        }
      }
      expect(spec.startsWith('STEP:synthesize')).toBe(true)
      phases.push('synthesize')
      const finalRound = firstVerdict === 'pass' ? 1 : 2
      expect(reports.filter((report) => report.round === finalRound)).toHaveLength(2)
      for (const report of reports) {
        expect(spec).toContain(`REVIEW_FILE: ${report.path}`)
        expect(readFileSync(report.path, 'utf8')).toBe(report.bytes)
      }
      if (firstVerdict === 'findings') {
        expect(spec).toContain('SOURCE_REPAIR_RECEIPT: Added the missing conclusion')
      }
      writeFileSync(join(workspace, 'deliverable.txt'), 'Synthesized final report')
      const output = sessionChainStepOutputDir(workspace, 'chain', 'outcome_synthesis')
      mkdirSync(output, { recursive: true })
      writeFileSync(join(output, 'manifest.md'), join(workspace, 'deliverable.txt'))
      return { body: 'SYNTHESIS_RECEIPT: Final report contains both reviewers’ findings.' }
    })
    fixtures.push(f)
    vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
      state: 'done',
      lastAssistantMessage: 'Original source report in ./deliverable.txt.',
      interactivePrompt: null,
      stateStartedAt: 1,
      updatedAt: 1
    })
    const sourceContext = vi.spyOn(f.runtime, 'readSessionOutcomeSourceContext').mockResolvedValue(
      firstVerdict === 'unverified-source'
        ? null
        : {
            paneKey: 'source',
            handle: 'source',
            processIncarnation: 'test:source:1',
            agent: 'codex',
            model: 'gpt-5.6-sol',
            effort: 'high',
            summary: 'Original source report in ./deliverable.txt.',
            files: ['deliverable.txt']
          }
    )
    f.write('deliverable.txt', 'Original candidate')
    const draft: NextStepDraft = {
      ...emptyNextStepDraft(),
      outcomes: [
        {
          id: 'outcome',
          finish: { kind: 'complete' },
          instructions: 'Write ./deliverable.txt.',
          steps: [
            {
              id: 'review',
              kind: 'review',
              reviewers: [
                { agent: 'codex', model: 'gpt-6-astra' },
                { agent: 'codex', model: 'gpt-6-astra' }
              ],
              maxRounds: 3,
              repairWithSource: true,
              instructions: 'STEP:review',
              adversarial: false
            },
            {
              id: 'synthesis',
              kind: 'handoff',
              actor: { agent: 'codex', model: 'gpt-5.6-sol' },
              presetId: 'synthesize',
              instructions: 'STEP:synthesize'
            }
          ]
        }
      ]
    }
    const compiled = compileNextStepChain({
      draft,
      chainId: 'chain',
      workspacePath: f.workspace,
      sessionLabel: 'Source report',
      defaultNote: 'Report',
      now: 1,
      mintStepId: (index) => `step_${index}`,
      mintOperationId: () => 'handoff'
    })
    expect(compiled.problems).toEqual([])
    expect(compiled.steps.filter((step) => step.kind !== 'handoff' && step.review)).toHaveLength(6)
    expect(compiled.steps.some((step) => step.kind !== 'handoff' && step.reviewRepair)).toBe(false)
    const definitions = compileNextStepOutcomes(draft.outcomes!, {
      chainId: 'chain',
      workspacePath: f.workspace,
      sessionLabel: 'Source report',
      fallbackActor: { agent: 'codex' },
      steps: compiled.steps
    })
    await f.service.commit(
      {
        id: 'chain',
        workspacePath: f.workspace,
        worktreeId: 'folder:outcome',
        hostId: 'local',
        sourcePaneKey: 'source',
        sourceRowKey: 'row',
        auto: true,
        steps: compiled.steps,
        currentIndex: 0,
        state: 'waiting',
        createdAt: 1,
        updatedAt: 1
      },
      { expectedRevision: 0, source: 'user', outcomes: definitions }
    )
    f.service.dispose()
    const committed = f.service.get('chain')
    if (firstVerdict === 'unverified-source') {
      await f.service.tick()
      await f.settle()
      expect(f.launched).toEqual([])
      // A refused capture is the host's to try again, never a question: recovering, no request.
      const held = f.service.get('chain').outcomeSet!
      const block = held.outcomes[0]!.block!
      expect(block).toMatchObject({ class: 'recovering', code: 'source-capture' })
      expect(held.continuation.state).toBe('owned')
      const progress = sessionOutcomeProgress(held, { now: block.since })
      expect(progress).toMatchObject({ phase: 'recovering', lifecycle: 'waiting', attention: [] })
      expect(held.attention ?? []).toEqual([])
      expect(progress.reasons.join(' ')).toContain(
        'original source agent and model could not be verified'
      )
      return
    }
    expect(materializeSessionOutcomeSourceRepairs(committed)).toBe(committed)
    sourceRepairs = committed.steps.filter(
      (step): step is SessionChainAgentStep => step.kind !== 'handoff' && Boolean(step.reviewRepair)
    )
    expect(sourceRepairs).toHaveLength(2)
    sourceContext.mockRejectedValue(
      new Error('Original source pane closed after its actor was saved.')
    )
    for (let index = 0; index < 24; index += 1) {
      await f.service.tick()
      await f.settle()
    }
    expect(phases).toEqual(
      firstVerdict === 'pass'
        ? ['review-1', 'review-1', 'synthesize']
        : firstVerdict === 'findings'
          ? ['review-1', 'review-1', 'repair', 'review-2', 'review-2', 'synthesize']
          : [
              'review-1',
              'review-1',
              'repair',
              'review-2',
              'review-2',
              'repair',
              'review-3',
              'review-3'
            ]
    )
    const finished = f.service.get('chain')
    const group = finished.reviewLoop!.groups[0]!
    expect(group.status).toBe(firstVerdict === 'capped' ? 'blocked' : 'passed')
    expect(group.rounds).toHaveLength(
      firstVerdict === 'pass' ? 1 : firstVerdict === 'findings' ? 2 : 3
    )
    for (const round of group.rounds) {
      expect(round.receipts).toHaveLength(2)
      expect(new Set(round.receipts.map((receipt) => receipt.candidateVersion))).toEqual(
        new Set([round.candidateVersion])
      )
    }
    expect(group.consumedRepairKeys).toEqual(
      sourceRepairs
        .slice(0, firstVerdict === 'pass' ? 0 : firstVerdict === 'findings' ? 1 : 2)
        .map((step) => step.reviewRepair!.consumptionKey)
    )
    for (const [index, round] of group.rounds.entries()) {
      if (index === 0) {
        continue
      }
      expect(round.candidateVersion).not.toBe(group.rounds[index - 1]!.candidateVersion)
      const attempt = finished.outcomeSet!.attempts.find(
        (entry) => entry.actionId === `step_${sourceRepairs[index - 1]!.id}`
      )!
      expect(attempt.state).toBe('completed')
      expect(
        JSON.parse(f.db.getWorkerDispatch(attempt.dispatchId!)!.start_options).launch.requested
      ).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high' })
    }
    expect(
      finished.outcomeSet!.attempts.filter(
        (attempt) => attempt.actionId === 'step_outcome_synthesis'
      )
    ).toMatchObject(firstVerdict === 'capped' ? [] : [{ state: 'completed' }])
    const progress = sessionOutcomeProgress(finished.outcomeSet!)
    if (firstVerdict === 'capped') {
      // Findings the three authorized rounds did not resolve are the owner's decision: needs-you
      // is that one open request, not the blocked reason beside it.
      expect(progress).toMatchObject({
        phase: 'needs-you',
        lifecycle: 'needs-you',
        attention: [
          {
            kind: 'decision',
            state: 'open',
            recipient: { type: 'owner' },
            source: { type: 'review-findings', ref: 'rounds:3' },
            scope: { outcomeId: 'outcome' }
          }
        ]
      })
      expect(finished.outcomeSet!.outcomes[0]!.block).toMatchObject({
        class: 'attention',
        code: 'review-findings',
        attentionIds: [progress.attention[0]!.id]
      })
      expect(progress.reasons.join(' ')).toContain('round cap')
    } else {
      expect(progress).toMatchObject({ phase: 'completed', lifecycle: 'complete', attention: [] })
    }
    expect(readFileSync(join(f.workspace, 'deliverable.txt'), 'utf8')).toBe(
      firstVerdict === 'capped' ? 'Repaired candidate 2' : 'Synthesized final report'
    )
    const before = f.launched.length
    f.runtime.replaceSessionChainOutcomesAndFlush(
      materializeSessionOutcomeSourceRepairs(finished),
      finished.outcomeSet!.revision
    )
    await f.service.tick()
    await f.settle()
    expect(f.launched).toHaveLength(before)
    if (firstVerdict === 'capped') {
      await f.service.suspend()
      f.closeDatabase()
      const reopened = outcomeRuntimeFixture(
        () => ({ body: 'Must not run after the cap' }),
        f.workspace
      )
      fixtures.push(reopened)
      const restored = reopened.service.get('chain')
      reopened.runtime.replaceSessionChainOutcomesAndFlush(
        materializeSessionOutcomeSourceRepairs(restored),
        restored.outcomeSet!.revision
      )
      await reopened.service.tick()
      await reopened.settle()
      expect(reopened.launched).toEqual([])
      expect(reopened.service.get('chain').reviewLoop).toEqual(finished.reviewLoop)
      // A restart re-observes the same requirement: the same request, never a second one.
      const restoredProgress = sessionOutcomeProgress(reopened.service.get('chain').outcomeSet!)
      expect(restoredProgress.phase).toBe('needs-you')
      expect(restoredProgress.attention.map((entry) => entry.id)).toEqual(
        progress.attention.map((entry) => entry.id)
      )
    }
  }
)
