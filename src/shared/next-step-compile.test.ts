import { describe, expect, it } from 'vitest'
import { compileNextStepChain } from './next-step-compile'
import {
  defaultNextStepInstructions,
  emptyNextStepDraft,
  type NextStepAgentRecipient,
  type NextStepDraft,
  type NextStepPersonRecipient
} from './next-step-draft'
import { sessionChainPredecessors } from './session-chain-types'

const claude: NextStepAgentRecipient = {
  kind: 'agent',
  key: 'a1',
  agent: 'claude',
  presetId: 'improve',
  instructions: '',
  model: 'claude-fable-5-1',
  effort: 'xhigh',
  rounds: 1
}
const astra: NextStepAgentRecipient = {
  kind: 'agent',
  key: 'a2',
  agent: 'codex',
  presetId: 'review',
  instructions: 'Look for money bugs.',
  rounds: 1
}
const uma: NextStepPersonRecipient = { kind: 'person', key: 'p1', id: 'emp_uma', name: 'Uma' }

let ids = 0
function compile(draft: NextStepDraft) {
  ids = 0
  return compileNextStepChain({
    draft,
    chainId: 'chn_1',
    workspacePath: '/Users/me/Webinar',
    sessionLabel: 'Build landing page',
    defaultNote: 'Current work from Build landing page.',
    now: 1000,
    mintStepId: (position) => `step_${position}`,
    mintOperationId: () => `fu_${(ids += 1)}`
  })
}

function draft(overrides: Partial<NextStepDraft>): NextStepDraft {
  return {
    ...emptyNextStepDraft(),
    handoff: {
      task: { id: 'btk_1', title: 'Landing page' },
      deliverables: null,
      includeSummary: true
    },
    ...overrides
  }
}

describe('compileNextStepChain', () => {
  it('addresses an existing agent session without sending to its employee owner', () => {
    const agentRecipient = {
      kind: 'agent' as const,
      id: 'session_uma',
      employeeId: 'emp_uma',
      projectId: 'project',
      name: 'Uma agent'
    }
    const { steps, problems } = compile(
      draft({
        handoff: { ...draft({}).handoff, sourceConversationId: 'chat_source' },
        outcomes: [
          {
            id: 'agent_delivery',
            instructions: 'Review the final file',
            steps: [],
            finish: {
              kind: 'person',
              personId: agentRecipient.employeeId,
              personName: agentRecipient.name,
              agentRecipient,
              disposition: 'ownership',
              action: 'fyi'
            }
          }
        ]
      })
    )
    expect(problems).toEqual([])
    expect(steps[0]).toMatchObject({
      kind: 'handoff',
      handoff: {
        recipients: [],
        agentRecipients: [{ ...agentRecipient, delivery: 'pending' }],
        sourceConversationId: 'chat_source'
      }
    })
  })
  it('keeps an ordinary message-only outcome without adding a summary or files', () => {
    const { steps, problems } = compile(
      draft({
        handoff: {
          task: { id: 'btk_1', title: 'Landing page' },
          includeSummary: false,
          deliverables: null,
          sourceConversationId: 'chat_source',
          communicationType: 'question'
        },
        outcomes: [
          {
            id: 'message',
            finish: {
              kind: 'person',
              personId: 'emp_uma',
              personName: 'Uma',
              disposition: 'feedback',
              action: 'review'
            },
            instructions: 'Which version should we use?',
            steps: []
          }
        ]
      })
    )
    expect(problems).toEqual([])
    expect(steps[0]).toMatchObject({
      kind: 'handoff',
      handoff: {
        includeSummary: false,
        deliverables: { kind: 'files', paths: [] },
        sourceConversationId: 'chat_source',
        communicationType: 'question',
        note: 'Which version should we use?'
      }
    })
  })
  it('combines selected files/folders with optional pinned history consent', () => {
    const source = {
      kind: 'provider' as const,
      hostId: 'local' as const,
      agent: 'codex',
      sessionId: 'original'
    }
    const { steps } = compile(
      draft({
        recipients: [uma],
        handoff: {
          task: { id: 'btk_1', title: 'Landing page' },
          includeSummary: false,
          deliverables: { kind: 'files', paths: ['/w/result.md', '/w/folder'] },
          includeTranscript: true,
          sourceConversationId: 'chat_original',
          transcriptSource: source
        }
      })
    )
    expect(steps[0]).toMatchObject({
      kind: 'handoff',
      handoff: {
        includeSummary: false,
        sourceConversationId: 'chat_original',
        transcriptSource: source,
        deliverables: { kind: 'files', paths: ['/w/result.md', '/w/folder'] }
      }
    })
  })
  it('names what stops an empty draft', () => {
    expect(compile(draft({ recipients: [] }))).toEqual({
      steps: [],
      problems: [{ kind: 'no-recipients' }]
    })
  })

  it('compiles grouped reviewers across revision-gated rounds with one repair per round', () => {
    const { steps, problems } = compile(
      draft({
        outcomes: [
          {
            id: 'outcome_1',
            revision: 3,
            finish: { kind: 'complete' },
            instructions: '',
            steps: [
              {
                id: 'review_1',
                kind: 'review',
                reviewers: [claude, astra],
                maxRounds: 3,
                instructions: 'Check the acceptance criteria.',
                adversarial: true
              },
              {
                id: 'repair_1',
                kind: 'handoff',
                reviewRepair: true,
                actor: { agent: 'claude' },
                presetId: 'implement',
                instructions: 'Repair only blocking findings.'
              }
            ]
          }
        ]
      })
    )
    expect(problems).toEqual([])
    expect(steps).toHaveLength(8)
    expect(
      steps.map((step) =>
        step.kind === 'handoff'
          ? 'person'
          : [step.review?.round ?? null, step.reviewRepair?.afterRound ?? null, step.group ?? null]
      )
    ).toEqual([
      [1, null, 'review_outcome_1_review_1_round_1'],
      [1, null, 'review_outcome_1_review_1_round_1'],
      [null, 1, null],
      [2, null, 'review_outcome_1_review_1_round_2'],
      [2, null, 'review_outcome_1_review_1_round_2'],
      [null, 2, null],
      [3, null, 'review_outcome_1_review_1_round_3'],
      [3, null, 'review_outcome_1_review_1_round_3']
    ])
    expect(
      steps
        .filter((step) => step.kind !== 'handoff' && step.reviewRepair)
        .map((step) => (step.kind === 'handoff' ? '' : step.reviewRepair!.consumptionKey))
    ).toEqual([
      'review_outcome_1_review_1:repair:1:outcome_1:revision:3',
      'review_outcome_1_review_1:repair:2:outcome_1:revision:3:revised-by:outcome_1_repair_1_repair-after-1'
    ])
  })

  it('keeps sequential handoffs for every configured outcome', () => {
    const first = {
      id: 'outcome_1',
      finish: { kind: 'complete' as const },
      instructions: '',
      steps: [
        {
          id: 'handoff_1',
          kind: 'handoff' as const,
          actor: { agent: 'claude' as const },
          presetId: 'implement' as const,
          instructions: 'Build the first outcome.'
        }
      ]
    }
    const second = {
      ...first,
      id: 'outcome_2',
      steps: [{ ...first.steps[0], id: 'handoff_2', instructions: 'Build the second outcome.' }]
    }
    const { steps } = compile(draft({ outcomes: [first, second] }))
    expect(
      steps.map((step) =>
        step.kind === 'handoff'
          ? ['', step.outcomeId]
          : [step.prompt.split('\n')[0], step.outcomeId]
      )
    ).toEqual([
      ['Build the first outcome.', 'outcome_1'],
      ['Build the second outcome.', 'outcome_2']
    ])
    expect(sessionChainPredecessors({ steps }, 1).map((step) => step.id)).toEqual([
      'outcome_1_handoff_1'
    ])
  })

  it('keeps logical review and handoff ids across reorder and unrelated outcomes', () => {
    const configured = {
      id: 'primary',
      finish: {
        kind: 'person' as const,
        personId: 'emp_uma',
        personName: 'Uma',
        disposition: 'ownership' as const,
        action: 'review' as const
      },
      instructions: 'Ship it.',
      steps: [
        {
          id: 'review-a',
          kind: 'review' as const,
          reviewers: [claude],
          maxRounds: 1,
          instructions: 'Review it.',
          adversarial: false
        }
      ]
    }
    const first = compile(draft({ outcomes: [configured] })).steps.map((step) => step.id)
    const added = compile(
      draft({
        outcomes: [
          { id: 'unrelated', finish: { kind: 'complete' }, instructions: '', steps: [] },
          configured
        ]
      })
    )
      .steps.filter((step) => step.outcomeId === configured.id)
      .map((step) => step.id)
    expect(added).toEqual(first)
    expect(first).toEqual(['primary_review-a_reviewer-claude-1_round-1', 'primary_person-handoff'])
  })

  it('keeps reviewer identities when distinct reviewers are reordered', () => {
    const review = {
      id: 'review-a',
      kind: 'review' as const,
      reviewers: [claude, astra],
      maxRounds: 1,
      instructions: 'Review it.',
      adversarial: false
    }
    const outcome = {
      id: 'primary',
      finish: { kind: 'complete' as const },
      instructions: '',
      steps: [review]
    }
    const ids = (reviewers: typeof review.reviewers) =>
      compile(draft({ outcomes: [{ ...outcome, steps: [{ ...review, reviewers }] }] }))
        .steps.map((step) => step.id)
        .sort()
    expect(ids([astra, claude])).toEqual(ids([claude, astra]))
  })

  it('hands off the actual final writer manifest', () => {
    const { steps } = compile(
      draft({
        outcomes: [
          {
            id: 'delivery',
            finish: {
              kind: 'person',
              personId: 'emp_uma',
              personName: 'Uma',
              disposition: 'ownership',
              action: 'fyi'
            },
            instructions: 'Check the report figures before using it.',
            steps: [
              {
                id: 'writer',
                kind: 'handoff',
                actor: { agent: 'claude' },
                presetId: 'implement',
                instructions: 'Write it.'
              }
            ]
          }
        ]
      })
    )
    const handoff = steps.at(-1)
    expect(handoff?.kind).toBe('handoff')
    if (handoff?.kind === 'handoff') {
      expect(handoff.handoff.deliverables).toEqual({
        kind: 'manifest',
        manifestPath: '/Users/me/Webinar/.omni/runs/chn_1/delivery_writer/manifest.md'
      })
      expect(handoff.handoff.includeSummary).toBe(true)
      expect(handoff.handoff.note).toBe('Check the report figures before using it.')
    }
  })

  it('preserves review action while separately transferring person ownership', () => {
    const { steps } = compile(
      draft({
        outcomes: [
          {
            id: 'outcome_1',
            finish: {
              kind: 'person',
              personId: 'emp_sal',
              personName: 'Sal',
              disposition: 'ownership',
              action: 'review'
            },
            instructions: '',
            steps: []
          }
        ]
      })
    )
    const step = steps[0]
    expect(step?.kind).toBe('handoff')
    if (step?.kind === 'handoff') {
      expect(step.handoff).toMatchObject({
        action: 'review',
        disposition: 'ownership-transfer'
      })
    }
  })

  it('one agent with an action is one step whose objective is pre-filled', () => {
    const { steps, problems } = compile(draft({ recipients: [claude] }))
    expect(problems).toEqual([])
    expect(steps).toEqual([
      {
        id: 'step_1',
        agent: 'claude',
        prompt: defaultNextStepInstructions('improve'),
        presetId: 'improve',
        model: 'claude-fable-5-1',
        effort: 'xhigh',
        status: 'queued'
      }
    ])
  })

  it('an agent with neither an action nor instructions is a problem, not a blank prompt', () => {
    const { steps, problems } = compile(
      draft({ recipients: [{ ...claude, presetId: null, instructions: '  ' }] })
    )
    expect(steps).toEqual([])
    expect(problems).toEqual([{ kind: 'agent-needs-action', key: 'a1' }])
  })

  it('rounds expand into sequential steps that feed each other', () => {
    const { steps } = compile(draft({ recipients: [{ ...claude, rounds: 3 }] }))
    expect(steps.map((step) => step.kind !== 'handoff' && step.round)).toEqual([
      { key: 'a1', index: 1, total: 3 },
      { key: 'a1', index: 2, total: 3 },
      { key: 'a1', index: 3, total: 3 }
    ])
    expect(steps.every((step) => !step.group)).toBe(true)
    expect(sessionChainPredecessors({ steps }, 2).map((step) => step.id)).toEqual(['step_2'])
  })

  it('one person is a handoff of the final summary with a default note and no action', () => {
    const { steps } = compile(draft({ recipients: [uma], note: '' }))
    expect(steps).toHaveLength(1)
    const step = steps[0]!
    expect(step.kind).toBe('handoff')
    if (step.kind !== 'handoff') {
      return
    }
    expect(step.handoff).toMatchObject({
      taskId: 'btk_1',
      taskTitle: 'Landing page',
      sessionLabel: 'Build landing page',
      recipients: [
        { employeeId: 'emp_uma', name: 'Uma', operationId: 'fu_1', delivery: 'pending' }
      ],
      deliverables: { kind: 'files', paths: [] },
      includeSummary: true,
      note: 'Current work from Build landing page.',
      savedAt: 1000
    })
    expect(step.handoff.action).toBeUndefined()
    // The default note is the plan speaking, never the sender.
    expect(step.handoff).not.toHaveProperty('noteAuthored')
  })

  it('marks a note the sender typed, even one that reads exactly like the card title', () => {
    const typed = (extra: Partial<NextStepDraft>) => {
      const step = compile(draft({ recipients: [uma], ...extra })).steps[0]!
      return step.kind === 'handoff' ? step.handoff : null
    }
    expect(typed({ note: 'Landing page', noteAuthored: true })).toMatchObject({
      note: 'Landing page',
      noteAuthored: true
    })
    // Typed but blank is the default note; unmarked text stays as it was before the mark existed.
    expect(typed({ note: '  ', noteAuthored: true })).not.toHaveProperty('noteAuthored')
    expect(typed({ note: 'Landing page' })).not.toHaveProperty('noteAuthored')
  })

  it('a person needs a task to land on', () => {
    const { problems } = compile(
      draft({
        recipients: [uma],
        handoff: { task: null, deliverables: null, includeSummary: true }
      })
    )
    expect(problems).toEqual([{ kind: 'no-task' }])
  })

  it('with card-less handoffs on, a person needs no task: the request stands on its own', () => {
    const cardless = draft({
      recipients: [uma],
      handoff: { task: null, deliverables: null, includeSummary: true }
    })
    const { steps, problems } = compileNextStepChain({
      draft: cardless,
      chainId: 'chn_1',
      workspacePath: '/Users/me/Webinar',
      sessionLabel: 'Build landing page',
      defaultNote: 'Current work from Build landing page.',
      now: 1000,
      mintStepId: (position) => `step_${position}`,
      mintOperationId: () => 'fu_x',
      cardlessHandoffs: true
    })
    expect(problems).toEqual([])
    expect(steps).toHaveLength(1)
    const step = steps[0]!
    if (step.kind !== 'handoff') {
      throw new Error('expected a handoff step')
    }
    expect(step.handoff.taskId).toBeNull()
    expect(step.handoff.taskTitle).toBe('Build landing page')
  })

  it('several recipients act in parallel after the same source; rounds collapse to one', () => {
    const { steps } = compile(
      draft({ recipients: [{ ...claude, rounds: 3 }, astra, uma], note: 'Please check this.' })
    )
    expect(steps.map((step) => [step.id, step.group, step.kind ?? 'agent'])).toEqual([
      ['step_1', 'g1', 'agent'],
      ['step_2', 'g1', 'agent'],
      ['step_3', 'g1', 'handoff']
    ])
    // Why: every member waits on the chain's source, none on a sibling.
    expect(sessionChainPredecessors({ steps }, 1)).toEqual([])
    expect(sessionChainPredecessors({ steps }, 2)).toEqual([])
  })

  it('synthesize after a fan-out waits on every agent of the group', () => {
    const { steps } = compile(
      draft({
        recipients: [claude, astra],
        after: [
          {
            kind: 'agent',
            key: 's1',
            actor: { agent: 'claude' },
            presetId: 'synthesize',
            instructions: 'Merge both.',
            rounds: 1
          }
        ]
      })
    )
    expect(steps).toHaveLength(3)
    expect(steps[2]).toMatchObject({ id: 'step_3', presetId: 'synthesize', prompt: 'Merge both.' })
    expect(steps[2]!.group).toBeUndefined()
    expect(sessionChainPredecessors({ steps }, 2).map((step) => step.id)).toEqual([
      'step_1',
      'step_2'
    ])
  })

  it('a person after a fan-out receives the manifests of every branch', () => {
    const { steps } = compile(
      draft({
        recipients: [claude, astra],
        after: [{ kind: 'person', key: 'p9', id: 'emp_sal', name: 'Sal' }]
      })
    )
    const last = steps[2]!
    expect(last.kind).toBe('handoff')
    if (last.kind !== 'handoff') {
      return
    }
    expect(last.handoff.deliverables).toEqual({
      kind: 'manifests',
      manifestPaths: [
        '/Users/me/Webinar/.omni/runs/chn_1/step_1/manifest.md',
        '/Users/me/Webinar/.omni/runs/chn_1/step_2/manifest.md'
      ]
    })
    expect(last.handoff.includeSummary).toBe(false)
  })

  it('a person after one agent with rounds receives the last round only', () => {
    const { steps } = compile(
      draft({
        recipients: [{ ...claude, rounds: 2 }],
        after: [{ kind: 'person', key: 'p9', id: 'emp_sal', name: 'Sal' }]
      })
    )
    const last = steps[2]!
    if (last.kind !== 'handoff') {
      throw new Error('expected a handoff')
    }
    expect(last.handoff.deliverables).toEqual({
      kind: 'manifest',
      manifestPath: '/Users/me/Webinar/.omni/runs/chn_1/step_2/manifest.md'
    })
  })

  it('follow-on steps run in order, each fed by the one before; a person is fed by the last agent', () => {
    const { steps, problems } = compile(
      draft({
        recipients: [{ ...claude, presetId: 'research' }],
        after: [
          {
            kind: 'agent',
            key: 'a2',
            actor: { agent: 'claude' },
            presetId: 'plan',
            instructions: '',
            rounds: 1
          },
          {
            kind: 'agent',
            key: 'a3',
            actor: { agent: 'codex' },
            presetId: 'implement',
            instructions: '',
            rounds: 2
          },
          { kind: 'person', key: 'p1', id: 'emp_uma', name: 'Uma' }
        ]
      })
    )
    expect(problems).toEqual([])
    expect(steps.map((step) => (step.kind === 'handoff' ? 'uma' : step.presetId))).toEqual([
      'research',
      'plan',
      'implement',
      'implement',
      'uma'
    ])
    expect(steps[2]).toMatchObject({ round: { key: 'a3', index: 1, total: 2 } })
    expect(sessionChainPredecessors({ steps }, 3).map((step) => step.id)).toEqual(['step_3'])
    const last = steps[4]!
    if (last.kind !== 'handoff') {
      throw new Error('expected a handoff')
    }
    expect(last.handoff.deliverables).toEqual({
      kind: 'manifest',
      manifestPath: '/Users/me/Webinar/.omni/runs/chn_1/step_4/manifest.md'
    })
  })

  it('a person follow-on without a person is a named problem', () => {
    const { steps, problems } = compile(
      draft({ recipients: [claude], after: [{ kind: 'person', key: 'p0', id: '', name: '' }] })
    )
    expect(steps).toEqual([])
    expect(problems).toEqual([{ kind: 'no-person' }])
  })
})

it('compiles explicit later review levels as a group and refuses a sixth level', () => {
  const after = [2, 2, 3, 4, 5].map((level, index) => ({
    kind: 'agent' as const,
    key: `after-${index}`,
    level,
    actor: { agent: 'codex' as const },
    presetId: 'review' as const,
    instructions: '',
    rounds: 1
  }))
  const result = compile(draft({ recipients: [claude], after, end: 'done' }))
  expect(result.problems).toEqual([])
  expect(result.steps.slice(1, 3).map((step) => step.group)).toEqual(['g2', 'g2'])
  expect(
    compile(draft({ recipients: [claude], after: [...after, { ...after[0]!, level: 6 }] })).problems
  ).toContainEqual({ kind: 'too-many-levels' })
})
