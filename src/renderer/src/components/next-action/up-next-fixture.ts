import { upNextAgentIntent } from '../../../../shared/up-next-agent-intent'
import { upNextCanAdd, upNextNumber, upNextTargetOf } from '../../../../shared/up-next-order'
import { upNextNotation, upNextSummary } from '../../../../shared/up-next-summary'
import type {
  UpNextAgentBlock,
  UpNextAttention,
  UpNextBlock,
  UpNextView
} from '../../../../shared/up-next-types'

/** The clock the fixture's `recoveringUntil` is 45 s ahead of. */
export const FIXTURE_NOW = 1_700_000_000_000

/** The host's own stall sentence: a diagnostic, so it may only ever appear under Details. */
export const STALL_DIAGNOSTIC =
  "No activity was observed for 180s after this step's instruction was accepted, so the step is not running. Open that conversation to see what happened, then run the step again."

/** A genuine request: the agent asked its person a question in its own conversation. */
export const ATTENTION_FIXTURE: UpNextAttention = {
  id: 'att_agent-prompt_a1_x1',
  kind: 'clarification',
  ask: 'Answer Claude Code’s question: Which price list is current?',
  why: 'Claude Code cannot choose this for you and is waiting for your answer.',
  action: { kind: 'open-conversation', label: 'Answer', paneKey: 'tab-9:leaf-1' }
}

const STOPPED_SCENARIOS = ['recovering', 'waiting', 'needs-you', 'failed'] as const
type StoppedScenario = (typeof STOPPED_SCENARIOS)[number]
const FINISHED_SCENARIOS = ['completed', 'closed', 'saved']

function isStopped(scenario: string): scenario is StoppedScenario {
  return (STOPPED_SCENARIOS as readonly string[]).includes(scenario)
}

/** The track stopped at its third stage, for one CLASS of reason; the fourth waits behind it. */
function stoppedBlocks(state: StoppedScenario): UpNextBlock[] {
  return [
    agentFixture('first', { state: 'done', locked: true }),
    agentFixture('second', { state: 'done', locked: true }),
    agentFixture('verify', {
      state,
      locked: true,
      template: 'verify',
      progress: {
        // An agent asking its person something carries a request, not a failure to diagnose.
        ...(state === 'needs-you'
          ? {}
          : { blockedReason: STALL_DIAGNOSTIC, stopCode: 'worker-stalled' }),
        stoppedAt: 1
      }
    }),
    agentFixture('improve', { state: 'waiting' })
  ]
}

function stoppedHeader(state: StoppedScenario): UpNextView['header'] {
  const stage = { n: 3, of: 4 }
  switch (state) {
    case 'recovering':
      return { state, stage, recoveringUntil: FIXTURE_NOW + 45_000 }
    case 'waiting':
      return { state, stage, wake: 'Jordan Taylor' }
    case 'needs-you':
      return { state, stage, attention: [ATTENTION_FIXTURE] }
    case 'failed':
      return { state, stage, failure: { code: 'worker-stalled', reason: STALL_DIAGNOSTIC } }
  }
}

export function agentFixture(id: string, patch: Partial<UpNextAgentBlock> = {}): UpNextAgentBlock {
  return {
    id,
    kind: 'agent',
    state: 'queued',
    number: '',
    locked: false,
    template: 'improve',
    shape: 'solo',
    n: 1,
    instruction: 'Improve the result.',
    output: 'result',
    advanced: {},
    promptCount: 0,
    ...patch,
    // Derived from the template exactly as the host derives it, unless a test pins it.
    intent: patch.intent ?? upNextAgentIntent(patch.template ?? 'improve')
  }
}
export function upNextFixture(scenario = 'busy'): UpNextView {
  const prompt: UpNextBlock = {
    id: 'prompt',
    kind: 'prompt',
    state: 'queued',
    number: '',
    locked: false,
    text: 'Check every Done When.',
    target: { kind: 'stage', blockId: 'review' }
  }
  const done: UpNextBlock = {
    id: 'done',
    kind: 'done',
    state: 'draft',
    number: '',
    locked: false,
    finish: 'close'
  }
  const review: UpNextBlock = {
    id: 'person',
    kind: 'person',
    state: 'queued',
    number: '',
    locked: false,
    relationship: 'review',
    people: [
      { id: 'emp_sal', name: 'Sal', initials: 'S' },
      { id: 'emp_iris', name: 'Iris', initials: 'I' }
    ],
    waitRule: 'all',
    resumesAtBlockId: 'improve',
    receive: { files: true, transcript: false, createTaskCard: false }
  }
  const scenarios: Record<string, UpNextBlock[]> = {
    busy: [],
    chain: [
      agentFixture('improve'),
      agentFixture('review', {
        template: 'review',
        shape: 'council',
        n: 3,
        output: 'findings',
        promptCount: 3
      }),
      prompt,
      { ...prompt, id: 'p2' },
      { ...prompt, id: 'p3' },
      agentFixture('verify', { template: 'verify', output: 'verdict' }),
      { ...review, relationship: 'handoff', people: review.people.slice(0, 1) }
    ],
    review: [
      review,
      { ...prompt, id: 'resume', target: { kind: 'resume-after-review', blockId: 'person' } },
      agentFixture('improve')
    ],
    running: [
      agentFixture('first', { state: 'done', locked: true, progress: { durationMs: 540000 } }),
      agentFixture('review', {
        state: 'running',
        locked: true,
        template: 'review',
        shape: 'parallel',
        n: 3,
        progress: {
          elapsedMs: 840000,
          seats: [
            { id: '1', state: 'done' },
            { id: '2', state: 'running' },
            { id: '3', state: 'running' }
          ]
        }
      }),
      agentFixture('improve'),
      prompt
    ],
    done: [agentFixture('verify', { template: 'verify' }), done],
    // A proven run with no terminal action: nothing was closed, so there is no Done block.
    completed: [
      agentFixture('first', { state: 'done', locked: true }),
      agentFixture('second', { state: 'done', locked: true })
    ],
    closed: [
      agentFixture('first', { state: 'done', locked: true }),
      agentFixture('second', { state: 'done', locked: true }),
      { ...done, state: 'done', locked: true, closedAt: 1 }
    ],
    saved: [
      agentFixture('first', { state: 'done', locked: true }),
      agentFixture('second', { state: 'done', locked: true }),
      { ...done, state: 'done', locked: true, finish: 'save', folderId: 'folder-1', savedAt: 1 }
    ]
  }
  const blocks = isStopped(scenario) ? stoppedBlocks(scenario) : (scenarios[scenario] ?? [])
  const numbering = upNextNumber(blocks)
  blocks.forEach((block, i) => {
    block.number = numbering.numbers[i]!
    if (block.kind === 'prompt') {
      block.target = upNextTargetOf(blocks, i)
    }
  })
  const finished = FINISHED_SCENARIOS.includes(scenario)
  const header: UpNextView['header'] = isStopped(scenario)
    ? stoppedHeader(scenario)
    : scenario === 'closed'
      ? {
          state: 'closed',
          completedAt: 1,
          closedAt: 1,
          disposition: { intent: 'close', state: 'applied', appliedAt: 1 }
        }
      : scenario === 'saved'
        ? {
            state: 'completed',
            completedAt: 1,
            disposition: { intent: 'save', state: 'applied', folderId: 'folder-1', appliedAt: 1 }
          }
        : scenario === 'completed'
          ? { state: 'completed', completedAt: 1 }
          : { state: scenario === 'done' ? 'idle' : 'running' }
  const now: UpNextView['now'] =
    scenario === 'running'
      ? { kind: 'stage', blockId: 'review' }
      : isStopped(scenario)
        ? { kind: 'stage', blockId: 'verify' }
        : scenario === 'closed'
          ? { kind: 'closed', at: 1 }
          : finished
            ? { kind: 'completed', at: 1 }
            : scenario === 'done'
              ? { kind: 'idle' }
              : { kind: 'current-work', agent: 'claude', label: 'Implement', elapsedMs: 840000 }
  const input = { blocks, header, now }
  return {
    conversationId: { worktreeId: 'folder:1', paneKey: 'pane', kind: 'pty' },
    rowKey: 'pane',
    ...input,
    notation: upNextNotation(input),
    summary: upNextSummary(input),
    canAdd: upNextCanAdd(blocks, finished ? 'closed' : header.state),
    draftCount: blocks.filter((block) => block.state === 'draft').length,
    queuedCount: finished ? 0 : blocks.filter((block) => block.state === 'queued').length
  }
}
