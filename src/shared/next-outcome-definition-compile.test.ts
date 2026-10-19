import { describe, expect, it } from 'vitest'
import { emptyNextStepDraft, type NextStepOutcomeDraft } from './next-step-draft'
import { compileNextStepChain } from './next-step-compile'
import { compileNextStepOutcomes } from './next-outcome-definition-compile'
import { validateSessionOutcomeDefinitions } from './session-outcome-validation'
import type { SessionChainStep } from './session-chain-types'

const context = (steps: SessionChainStep[] = []) => ({
  chainId: 'chn_1',
  workspacePath: '/work',
  sessionLabel: 'Build the result',
  fallbackActor: { agent: 'codex' as const },
  steps,
  workingBranch: 'feature/outcomes',
  workingHead: 'abc123'
})

function outcome(finish: NextStepOutcomeDraft['finish']): NextStepOutcomeDraft {
  return { id: 'outcome_1', finish, instructions: 'Deliver the requested result.', steps: [] }
}

function producedReview(rounds: number, writerAfterReview = false, secondReviewGroup = false) {
  const draft: NextStepOutcomeDraft = {
    ...outcome({ kind: 'complete' }),
    steps: [
      {
        id: 'producer',
        kind: 'handoff',
        actor: { agent: 'codex' },
        presetId: 'implement',
        instructions: 'Produce the result'
      },
      {
        id: 'review',
        kind: 'review',
        reviewers: [{ agent: 'claude' }, { agent: 'codex' }],
        maxRounds: rounds,
        adversarial: false,
        instructions: 'Review the produced result'
      },
      ...(rounds > 1
        ? [
            {
              id: 'repair',
              kind: 'handoff' as const,
              actor: { agent: 'codex' as const },
              presetId: 'improve' as const,
              instructions: 'Repair blocking findings',
              reviewRepair: true
            }
          ]
        : []),
      ...(writerAfterReview
        ? [
            {
              id: 'final_writer',
              kind: 'handoff' as const,
              actor: { agent: 'codex' as const },
              presetId: 'improve' as const,
              instructions: 'Produce the final revised result'
            }
          ]
        : []),
      ...(secondReviewGroup
        ? [
            {
              id: 'final_review',
              kind: 'review' as const,
              reviewers: [{ agent: 'claude' as const }],
              maxRounds: 2,
              adversarial: false,
              instructions: 'Review the revised result'
            },
            {
              id: 'final_repair',
              kind: 'handoff' as const,
              actor: { agent: 'codex' as const },
              presetId: 'improve' as const,
              instructions: 'Repair the final review findings',
              reviewRepair: true
            }
          ]
        : [])
    ]
  }
  const compiled = compileNextStepChain({
    ...context(),
    draft: { ...emptyNextStepDraft(), outcomes: [draft] },
    defaultNote: '',
    now: 1,
    mintStepId: () => {
      throw new Error('Outcome steps must have deterministic IDs.')
    },
    mintOperationId: () => {
      throw new Error('No person handoff requested.')
    }
  })
  expect(compiled.problems).toEqual([])
  return { draft, steps: compiled.steps }
}

describe('compileNextStepOutcomes', () => {
  it('makes ordinary Complete executable with a host-verifiable output file', () => {
    const [definition] = compileNextStepOutcomes([outcome({ kind: 'complete' })], context())
    expect(definition?.conditions).toEqual([
      {
        id: 'outcome_1_result',
        kind: 'file',
        target: '/work/.omni/runs/chn_1/outcome_outcome_1/result.md'
      }
    ])
    expect(definition?.actions).toHaveLength(1)
    expect(definition?.actions[0]?.instruction).toContain('process exit alone is not success')
  })

  it('owns compiled steps per outcome and never repeats reviewers as finish writers', () => {
    const steps: SessionChainStep[] = [
      {
        id: 'review_a',
        outcomeId: 'outcome_1',
        agent: 'codex',
        prompt: 'Review',
        review: {
          groupId: 'g',
          reviewerId: 'a',
          round: 1,
          maxRounds: 1,
          candidateVersion: 'pending'
        },
        status: 'queued'
      },
      {
        id: 'writer',
        outcomeId: 'outcome_1',
        agent: 'claude',
        prompt: 'Repair',
        status: 'queued'
      },
      { id: 'other', outcomeId: 'outcome_2', agent: 'codex', prompt: 'Other', status: 'queued' }
    ]
    const [definition] = compileNextStepOutcomes([outcome({ kind: 'complete' })], context(steps))
    expect(definition?.stepIds).toEqual(['review_a', 'writer'])
    expect(definition?.actions).toEqual([])
    expect(definition?.conditions).toEqual([
      { id: 'outcome_1_result', kind: 'file', target: '/work/.omni/runs/chn_1/writer/manifest.md' }
    ])
  })

  it.each([1, 2])(
    'requires the producer manifest and current reviewer reports over %i rounds',
    (rounds) => {
      const { draft, steps } = producedReview(rounds)
      const [definition] = compileNextStepOutcomes([draft], context(steps))
      const firstRound = steps.filter((step) => step.kind !== 'handoff' && step.review?.round === 1)
      expect(definition.conditions).toEqual([
        {
          id: 'outcome_1_result',
          kind: 'file',
          target: '/work/.omni/runs/chn_1/outcome_1_producer/manifest.md'
        },
        ...firstRound.map((step, index) => ({
          id: `outcome_1_report_${index + 1}`,
          kind: 'report',
          target: step.id
        }))
      ])
      expect(definition.actions).toEqual([])
      expect(definition.stepIds).toEqual(steps.map((step) => step.id))
      expect(definition.conditions.every((condition) => !condition.target.includes('repair'))).toBe(
        true
      )
      if (rounds === 2) {
        const lastRound = steps.filter(
          (step) => step.kind !== 'handoff' && step.review?.round === 2
        )
        expect(lastRound).toHaveLength(2)
        // Report verification follows each initial target's reviewerId to its latest executed round.
        expect(lastRound.map((step) => step.kind !== 'handoff' && step.review?.reviewerId)).toEqual(
          firstRound.map((step) => step.kind !== 'handoff' && step.review?.reviewerId)
        )
        expect(
          definition.conditions.every(
            (condition) => !lastRound.some((step) => step.id === condition.target)
          )
        ).toBe(true)
      }
      expect(() => validateSessionOutcomeDefinitions([definition])).not.toThrow()
    }
  )

  it('does not require stale intermediate review reports after an ordinary final writer', () => {
    const { draft, steps } = producedReview(2, true)
    const [definition] = compileNextStepOutcomes([draft], context(steps))
    expect(steps.some((step) => step.kind !== 'handoff' && step.review)).toBe(true)
    expect(definition.conditions).toEqual([
      {
        id: 'outcome_1_result',
        kind: 'file',
        target: '/work/.omni/runs/chn_1/outcome_1_final_writer/manifest.md'
      }
    ])
    expect(definition.stepIds).toEqual(steps.map((step) => step.id))
  })

  it('uses only the final review group reports when its repair can revise an earlier reviewed candidate', () => {
    const { draft, steps } = producedReview(2, false, true)
    const [definition] = compileNextStepOutcomes([draft], context(steps))
    const finalReport = steps.find(
      (step) =>
        step.kind !== 'handoff' && step.editorStepId === 'final_review' && step.review?.round === 1
    )!
    expect(definition.conditions).toEqual([
      {
        id: 'outcome_1_result',
        kind: 'file',
        target: '/work/.omni/runs/chn_1/outcome_1_producer/manifest.md'
      },
      { id: 'outcome_1_report_1', kind: 'report', target: finalReport.id }
    ])
    expect(
      steps.some(
        (step) =>
          step.kind !== 'handoff' && step.editorStepId === 'final_repair' && step.reviewRepair
      )
    ).toBe(true)
    expect(definition.stepIds).toEqual(steps.map((step) => step.id))
  })

  it('keeps merge target separate from the working branch used for PR lookup', () => {
    const [definition] = compileNextStepOutcomes(
      [
        outcome({
          kind: 'github',
          action: 'merge',
          repository: 'omnirogue/orca',
          targetBranch: 'main-next'
        })
      ],
      context()
    )
    expect(definition?.conditions[0]).toMatchObject({
      kind: 'merge',
      repository: 'omnirogue/orca',
      branch: 'feature/outcomes',
      targetBranch: 'main-next',
      version: 'abc123'
    })
    expect(definition?.actions[0]?.instruction).toContain('Merge target branch: main-next')
  })

  it('does not treat a synthetic draft revision as human-review evidence', () => {
    const [definition] = compileNextStepOutcomes(
      [{ ...outcome({ kind: 'my-review' }), revision: 9 }],
      context()
    )
    expect(definition?.conditions[0]).toEqual({
      id: 'outcome_1_review',
      kind: 'review',
      target: 'outcome_1'
    })
  })

  it('carries custom review and concrete Complete instructions through host validation', () => {
    const definitions = compileNextStepOutcomes(
      [
        {
          ...outcome({ kind: 'my-review' }),
          instructions: 'Review the isolated test outcome.'
        },
        {
          ...outcome({ kind: 'complete' }),
          id: 'outcome_2',
          instructions: 'Save /output/meaningful-result.md'
        }
      ],
      context()
    )
    const [definition, complete] = definitions

    expect(definition.actions).toEqual([
      expect.objectContaining({
        id: 'outcome_1_finish',
        instruction: 'Review the isolated test outcome.',
        conditionIds: ['outcome_1_review']
      })
    ])
    expect(complete.conditions).toEqual([
      { id: 'outcome_2_file_1', kind: 'file', target: '/output/meaningful-result.md' }
    ])
    expect(complete.actions[0]?.instruction).toContain('/output/meaningful-result.md')
    expect(() => validateSessionOutcomeDefinitions(definitions)).not.toThrow()
    expect(definition.conditions).toEqual([
      { id: 'outcome_1_review', kind: 'review', target: 'outcome_1' }
    ])
  })

  it('separates feedback acceptance from delivery while ownership transfer ends at delivery', () => {
    const [feedback] = compileNextStepOutcomes(
      [
        outcome({
          kind: 'person',
          personId: 'person_1',
          personName: 'Reviewer',
          action: 'review',
          disposition: 'feedback'
        })
      ],
      context()
    )
    expect(feedback?.conditions).toEqual([
      {
        id: 'outcome_1_handoff',
        kind: 'handoff',
        target: 'person_1',
        recipientId: 'person_1'
      },
      {
        id: 'outcome_1_feedback',
        kind: 'review',
        target: 'person_1',
        recipientId: 'person_1'
      }
    ])
    expect(feedback?.actions).toEqual([])

    const [ownership] = compileNextStepOutcomes(
      [
        outcome({
          kind: 'person',
          personId: 'person_1',
          personName: 'Owner',
          action: 'fyi',
          disposition: 'ownership'
        })
      ],
      context()
    )
    expect(ownership?.conditions.map((condition) => condition.kind)).toEqual(['handoff'])
    expect(ownership?.actions).toEqual([])
  })
})

describe('concrete finish admission', () => {
  it.each([
    'Publish the video to YouTube.',
    'Release the app.',
    'Update linked Drive file https://drive.google.com/file/d/stable-id/view',
    'Write a report and publish the video.'
  ])('refuses note-only evidence for %s', (instructions) => {
    expect(() =>
      compileNextStepOutcomes([{ ...outcome({ kind: 'complete' }), instructions }], context())
    ).toThrow('unsupported')
  })

  it.each(['/Users/maintainer/Desktop/result.md', 'C:\\Users\\Sal\\result.md', './output/result.json'])(
    'preserves explicit host destination %s',
    (target) => {
      const [definition] = compileNextStepOutcomes(
        [{ ...outcome({ kind: 'complete' }), instructions: `Save "${target}"` }],
        context()
      )
      expect(definition.conditions).toEqual([{ id: 'outcome_1_file_1', kind: 'file', target }])
      expect(definition.actions[0].instruction).toContain(target)
      expect(definition.actions[0].instruction).not.toContain('/.omni/runs/')
    }
  )

  it('keeps every file obligation and refuses partially understood instructions', () => {
    const [definition] = compileNextStepOutcomes(
      [
        {
          ...outcome({ kind: 'complete' }),
          instructions: 'Save /output/one.md and save /output/two.md'
        }
      ],
      context()
    )
    expect(definition.conditions.map((entry) => entry.target)).toEqual([
      '/output/one.md',
      '/output/two.md'
    ])
    expect(() =>
      compileNextStepOutcomes(
        [
          {
            ...outcome({ kind: 'complete' }),
            instructions: 'Save /output/one.md and build the application'
          }
        ],
        context()
      )
    ).toThrow('needs-details')
  })

  it('uses persisted reviewer reports with no hidden finish writer or later-round obligation', () => {
    const steps: SessionChainStep[] = [1, 2].map((round) => ({
      id: `review_${round}`,
      outcomeId: 'outcome_1',
      agent: 'codex',
      prompt: 'Review the result',
      status: 'queued',
      review: { groupId: 'g', reviewerId: 'r', round, maxRounds: 2, candidateVersion: 'pending' }
    }))
    const [definition] = compileNextStepOutcomes([outcome({ kind: 'complete' })], context(steps))
    expect(definition.actions).toEqual([])
    expect(definition.conditions).toEqual([
      { id: 'outcome_1_report_1', kind: 'report', target: 'review_1' }
    ])
    expect(definition.stepIds).toEqual(['review_1', 'review_2'])
  })

  it('does not require a conditional repair file when reviewers approve without a repair', () => {
    const review = (round: number): SessionChainStep => ({
      id: `review_${round}`,
      outcomeId: 'outcome_1',
      agent: 'claude',
      prompt: 'Review the result',
      status: 'queued',
      review: { groupId: 'g', reviewerId: 'r', round, maxRounds: 2, candidateVersion: 'pending' }
    })
    const steps: SessionChainStep[] = [
      review(1),
      {
        id: 'conditional_repair',
        outcomeId: 'outcome_1',
        agent: 'codex',
        prompt: 'Repair blocking findings',
        status: 'queued',
        reviewRepair: {
          groupId: 'g',
          afterRound: 1,
          candidateVersion: 'pending',
          consumptionKey: 'g:repair:1:pending'
        }
      },
      review(2)
    ]
    const [definition] = compileNextStepOutcomes([outcome({ kind: 'complete' })], context(steps))
    expect(definition.conditions).toEqual([
      { id: 'outcome_1_report_1', kind: 'report', target: 'review_1' }
    ])
    expect(definition.actions).toEqual([])
    expect(definition.stepIds).toEqual(['review_1', 'conditional_repair', 'review_2'])

    const [withFile] = compileNextStepOutcomes(
      [{ ...outcome({ kind: 'complete' }), instructions: 'Save /output/report.md' }],
      context(steps)
    )
    expect(withFile.conditions).toEqual([
      { id: 'outcome_1_file_1', kind: 'file', target: '/output/report.md' }
    ])
  })
})

describe('editing source-inferred outcome sets', () => {
  it('preserves unchanged typed targets, action IDs and dependencies through a draft round trip', () => {
    const draft = { ...outcome({ kind: 'complete' }), instructions: 'Build the advanced UI' }
    const prior = {
      id: draft.id,
      title: 'Advanced UI',
      finish: 'complete' as const,
      instructions: draft.instructions,
      dependsOn: ['release'],
      conditions: [
        {
          id: 'build',
          kind: 'command' as const,
          target: 'ui-build',
          verification: { program: 'pnpm', args: ['build'] }
        }
      ],
      actions: [
        {
          id: 'existing_action',
          instruction: draft.instructions,
          conditionIds: ['build'],
          authority: 'existing-user-authority' as const,
          agent: 'codex' as const
        }
      ]
    }
    const [definition] = compileNextStepOutcomes([draft], {
      ...context(),
      committed: { definitions: [prior], drafts: [draft] }
    })
    expect(definition).toEqual({ ...prior, stepIds: [] })
    expect(prior).not.toHaveProperty('stepIds')
  })
  it('does not silently drop dependencies when finish instructions are edited', () => {
    const draft = { ...outcome({ kind: 'complete' }), instructions: 'Save /output/old.md' }
    const [prior] = compileNextStepOutcomes([draft], context())
    prior.dependsOn = ['first']
    const [edited] = compileNextStepOutcomes([{ ...draft, instructions: 'Save /output/new.md' }], {
      ...context(),
      committed: { definitions: [prior], drafts: [draft] }
    })
    expect(edited.dependsOn).toEqual(['first'])
    expect(edited.conditions[0].target).toBe('/output/new.md')
  })
})

it('refuses a new deployment finish without a supported authorized deployment verifier', () => {
  expect(() =>
    compileNextStepOutcomes(
      [
        outcome({
          kind: 'github',
          action: 'merge-and-deploy',
          repository: 'org/app',
          deploymentTarget: 'test-cluster'
        })
      ],
      context()
    )
  ).toThrow('deployment verifier')
})

it('saving an otherwise empty Next choice waits for the original source without another writer', () => {
  const definitions = compileNextStepOutcomes(
    [{ id: 'done', finish: { kind: 'complete' }, instructions: '', steps: [] }],
    { ...context(), sourcePaneKey: 'tab:leaf' }
  )
  expect(definitions[0]?.conditions).toEqual([
    { id: 'done_source', kind: 'session', target: 'tab:leaf' }
  ])
  expect(definitions[0]?.actions).toEqual([])
  expect(() => validateSessionOutcomeDefinitions(definitions)).not.toThrow()
})
