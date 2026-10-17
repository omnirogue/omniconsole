import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { compileNextStepChain } from '../../shared/next-step-compile'
import { compileNextStepOutcomes } from '../../shared/next-outcome-definition-compile'
import { emptyNextStepDraft, type NextStepDraft } from '../../shared/next-step-draft'
import { sessionChainStepOutputDir } from '../../shared/session-chain-types'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
})

it.each(['pass', 'findings'] as const)(
  'launches the configured next agent once with the files and reports after a %s review',
  async (status) => {
    let reports = 0
    const f = outcomeRuntimeFixture((spec, workspace) => {
      const step = /STEP:(\w+)/.exec(spec)![1]!
      if (step === 'review') {
        reports += 1
        return {
          body: [
            `REVIEW_EVIDENCE_${reports}: ${join(workspace, `review-${reports}.md`)}`,
            `OMNI_REVIEW_RESULT:${JSON.stringify({
              status,
              blockingFindings: status === 'findings' ? ['Explain the tradeoffs.'] : []
            })}`
          ].join('\n')
        }
      }
      expect(step).toBe('synthesize')
      for (const reviewer of [1, 2]) {
        const path = join(workspace, `review-${reviewer}.md`)
        expect(spec).toContain(`REVIEW_EVIDENCE_${reviewer}: ${path}`)
        expect(readFileSync(path, 'utf8')).toBe(`Notes from reviewer ${reviewer}`)
      }
      const outputDir = sessionChainStepOutputDir(workspace, 'chain', 'outcome_next-agent')
      mkdirSync(outputDir, { recursive: true })
      writeFileSync(join(workspace, 'deliverable.txt'), 'Combined findings with tradeoffs.')
      writeFileSync(join(outputDir, 'manifest.md'), join(workspace, 'deliverable.txt'))
      return { body: 'Combined both reviews into deliverable.txt.' }
    })
    fixtures.push(f)
    f.write('deliverable.txt', 'Original candidate')
    for (const reviewer of [1, 2]) {
      f.write(`review-${reviewer}.md`, `Notes from reviewer ${reviewer}`)
    }
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
                { agent: 'codex', model: 'gpt-5.6-sol' },
                { agent: 'codex', model: 'gpt-5.6-sol' }
              ],
              maxRounds: 1,
              instructions: 'STEP:review',
              adversarial: false
            },
            {
              id: 'next-agent',
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
      sessionLabel: 'Reviewed report',
      defaultNote: 'Report',
      now: 1,
      mintStepId: (index) => `step_${index}`,
      mintOperationId: () => 'handoff'
    })
    expect(compiled.problems).toEqual([])
    const definitions = compileNextStepOutcomes(draft.outcomes!, {
      chainId: 'chain',
      workspacePath: f.workspace,
      sessionLabel: 'Reviewed report',
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
    for (let index = 0; index < 20; index += 1) {
      await f.service.tick()
      await f.settle()
    }
    expect(f.launched.map((spec) => /STEP:(\w+)/.exec(spec)![1])).toEqual([
      'review',
      'review',
      'synthesize'
    ])
    const chain = f.service.get('chain')
    const reviewerAttempts = chain.outcomeSet!.attempts.filter((attempt) =>
      attempt.actionId.startsWith('step_outcome_review_')
    )
    expect(reviewerAttempts).toHaveLength(2)
    expect(new Set(reviewerAttempts.map((attempt) => attempt.dispatchId)).size).toBe(2)
    expect(chain.reviewLoop!.groups[0]!.status).toBe(
      status === 'pass' ? 'passed' : 'report-complete'
    )
    expect(
      chain.outcomeSet!.attempts.filter((attempt) => attempt.actionId === 'step_outcome_next-agent')
    ).toMatchObject([{ state: 'completed' }])
    expect(sessionOutcomeProgress(chain.outcomeSet!).lifecycle).toBe('complete')
    expect(readFileSync(join(f.workspace, 'deliverable.txt'), 'utf8')).toBe(
      'Combined findings with tradeoffs.'
    )
    await f.service.tick()
    await f.settle()
    expect(f.launched).toHaveLength(3)
  }
)
