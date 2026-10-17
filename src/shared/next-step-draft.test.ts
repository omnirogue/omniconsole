import { describe, expect, it } from 'vitest'
import { emptyNextStepDraft, nextStepOutcomeProblems } from './next-step-draft'

describe('nextStepOutcomeProblems', () => {
  it('requires every outcome to have an explicit finish', () => {
    expect(nextStepOutcomeProblems(emptyNextStepDraft().outcomes)).toEqual([
      'Define a finish for every outcome.'
    ])
  })

  it('requires only target details that a chosen finish needs', () => {
    expect(
      nextStepOutcomeProblems([
        {
          id: 'outcome-1',
          instructions: '',
          steps: [],
          finish: { kind: 'github', action: 'merge-and-deploy', repository: 'omnirogue/omni-ide' }
        }
      ])
    ).toEqual(['Choose a deployment target when it cannot be inferred.'])
  })

  it('limits new plans to six sequential handoffs but keeps persisted longer plans valid', () => {
    const handoffs = Array.from({ length: 7 }, (_, index) => ({
      id: `step-${index}`,
      kind: 'handoff' as const,
      actor: { agent: 'codex' as const },
      presetId: 'implement' as const,
      instructions: `Step ${index}`
    }))
    const draft = {
      id: 'outcome-1',
      instructions: '',
      steps: handoffs,
      finish: { kind: 'complete' as const }
    }
    expect(nextStepOutcomeProblems([draft])).toContain(
      'Choose up to six sequential agent handoffs.'
    )
    expect(nextStepOutcomeProblems([{ ...draft, revision: 3 }])).toEqual([])
  })

  it('does not mistake a saved status for verified completion', () => {
    expect(
      nextStepOutcomeProblems([
        {
          id: 'outcome-1',
          instructions: '',
          steps: [],
          status: 'complete',
          finish: { kind: 'complete' }
        }
      ])
    ).toEqual([])
  })
})

it.each([
  [{ agent: 'codex' }, [{ agent: 'codex' }]],
  [null, [{ agent: 'codex' }, { agent: 'codex' }]],
  [null, [{ agent: 'codex', model: ' ' }, { agent: 'codex' }]],
  [
    null,
    [
      { agent: 'codex', model: 'one' },
      { agent: 'codex', model: 'one' }
    ]
  ],
  [{ agent: 'codex', model: 'one' }, [{ agent: 'codex', model: 'one' }]],
  [{ agent: 'codex', model: 'one' }, [{ agent: 'codex', model: 'two' }]],
  [{ agent: 'codex' }, [{ agent: 'claude' }]]
] as const)(
  'allows independent reviewers to use the same provider or model as other seats (%j, %j)',
  (producer, reviewers) => {
    const problems = nextStepOutcomeProblems([
      {
        id: 'outcome',
        instructions: '',
        finish: { kind: 'complete' },
        steps: [
          ...(producer
            ? [
                {
                  id: 'producer',
                  kind: 'handoff' as const,
                  actor: producer,
                  presetId: 'implement' as const,
                  instructions: ''
                }
              ]
            : []),
          {
            id: 'review',
            kind: 'review',
            reviewers: [...reviewers],
            maxRounds: 1,
            adversarial: false,
            instructions: ''
          }
        ]
      }
    ])
    expect(problems).toEqual([])
  }
)
