import type {
  LocalWorkflowCallView,
  LocalWorkflowDiscoverFinding,
  LocalWorkflowSeatView,
  LocalWorkflowView
} from '../../../../shared/local-workflow-view'
import { workflowView } from './local-workflow-ui.fixtures'

const SEATS: Record<string, LocalWorkflowSeatView> = {
  'seat-1': {
    seatId: 'seat-1',
    agent: 'claude',
    model: 'claude-opus-5',
    modelLabel: 'Claude Opus 5',
    effort: 'high'
  },
  'seat-2': {
    seatId: 'seat-2',
    agent: 'codex',
    model: 'gpt-5.6-sol',
    modelLabel: 'GPT-5.6 Sol',
    effort: 'high'
  },
  'seat-3': {
    seatId: 'seat-3',
    agent: 'grok',
    model: 'grok-4.6-build',
    modelLabel: 'Grok 4.6',
    effort: null
  },
  'seat-4': {
    seatId: 'seat-4',
    agent: 'gemini',
    model: 'gemini-3.8-flash',
    modelLabel: 'Gemini 3.8 Flash',
    effort: null
  }
}

export function workflowCall(
  id: string,
  seatId: string,
  patch: Partial<LocalWorkflowCallView> = {}
): LocalWorkflowCallView {
  const seat = SEATS[seatId]
  return {
    id,
    stageId: id.split('/')[0],
    seatId,
    agent: seat.agent,
    seatLabel: seat.modelLabel.split(' ')[0],
    modelLabel: seat.modelLabel,
    model: seat.model,
    effort: seat.effort,
    state: 'completed',
    attempt: 1,
    attemptLimit: 2,
    transport: 'headless',
    stdout: '',
    stderr: '',
    outputTruncated: false,
    startedAt: 1_000_000,
    endedAt: 1_072_000,
    tokens: { input: 2_100, output: 1_300 },
    ...patch
  }
}

/** Council revision 6 mid-run: three answers in, Grok still writing, rankings under way. */
export function councilRunView(): LocalWorkflowView {
  return {
    ...workflowView(),
    revision: 6,
    phase: 'Peer rankings',
    running: 2,
    queued: 0,
    stages: [
      { id: 'answer', label: 'First opinions', completed: 3, total: 4, failed: 0 },
      { id: 'rank', label: 'Peer rankings', completed: 1, total: 3, failed: 0 },
      { id: 'chair', label: 'Chairman', completed: 0, total: 1, failed: 0 }
    ],
    calls: [
      workflowCall('answer/seat-1', 'seat-1', {
        resultMarkdown: '## Use an idempotency key\nStore it with the charge.'
      }),
      workflowCall('answer/seat-2', 'seat-2', { resultMarkdown: 'Persist the result first.' }),
      workflowCall('answer/seat-3', 'seat-3', {
        state: 'running',
        endedAt: undefined,
        tokens: undefined,
        live: {
          phase: 'running',
          startedAt: Date.now() - 42_000,
          activity: 'Reading src/checkout/pay.ts',
          tail: 'The retry path re-enters charge() without the original key, so'
        }
      }),
      workflowCall('answer/seat-4', 'seat-4', { resultMarkdown: 'Retry with backoff.' }),
      workflowCall('rank/seat-1', 'seat-1'),
      workflowCall('rank/seat-2', 'seat-2', { state: 'running', endedAt: undefined })
    ],
    councilRun: {
      members: [
        { ...SEATS['seat-1'], label: 'Response A', votes: true, answerCallId: 'answer/seat-1' },
        { ...SEATS['seat-2'], label: 'Response B', votes: true, answerCallId: 'answer/seat-2' },
        { ...SEATS['seat-3'], label: 'Response C', votes: true, answerCallId: 'answer/seat-3' },
        { ...SEATS['seat-4'], label: 'Response D', votes: false, answerCallId: 'answer/seat-4' }
      ],
      chair: SEATS['seat-1'],
      ballots: [
        {
          reviewerSeatId: 'seat-1',
          callId: 'rank/seat-1',
          evaluation:
            'Response B is precise. Response A misses the retry path.\n\nFINAL RANKING:\n1. Response B\n2. Response A\n3. Response D',
          ranking: ['Response B', 'Response A', 'Response D']
        }
      ],
      standings: [
        { label: 'Response B', seatId: 'seat-2', averageRank: 1, votes: 1, place: 1 },
        { label: 'Response D', seatId: 'seat-4', averageRank: 3, votes: 1, place: 2 }
      ],
      selfVotesExcluded: true
    }
  }
}

/** The same council after the chairman answered: every stage done, the answer accepted. */
export function completedCouncilRunView(): LocalWorkflowView {
  const view = councilRunView()
  return {
    ...view,
    state: 'completed',
    finishedAt: view.startedAt + 200_000,
    running: 0,
    actions: [],
    stages: [
      { id: 'answer', label: 'First opinions', completed: 4, total: 4, failed: 0 },
      { id: 'rank', label: 'Peer rankings', completed: 3, total: 3, failed: 0 },
      { id: 'chair', label: 'Chairman', completed: 1, total: 1, failed: 0 }
    ],
    calls: [
      ...view.calls.map((call) => ({ ...call, state: 'completed' as const, live: undefined })),
      workflowCall('rank/seat-3', 'seat-3'),
      workflowCall('chair/final', 'seat-1', { resultMarkdown: 'Reuse the original key.' })
    ],
    result: {
      markdown: '## Verdict\nReuse the original key on every retry.',
      sources: [],
      coverage: []
    },
    followUpLabel: 'Claude Opus 5'
  }
}

function finding(
  id: string,
  patch: Partial<LocalWorkflowDiscoverFinding>
): LocalWorkflowDiscoverFinding {
  return {
    id,
    title: 'Retry drops the idempotency key',
    location: 'src/checkout/pay.ts:142',
    severity: 'high',
    lens: 'reliability',
    area: 'Checkout',
    round: 1,
    foundBy: SEATS['seat-2'],
    markdown: 'A second charge runs when the first times out.',
    status: 'confirmed',
    votes: [
      {
        lens: 'correctness',
        seat: SEATS['seat-1'],
        state: 'done',
        verdict: 'real',
        reason: 'Key is rebuilt.'
      },
      { lens: 'reachability', seat: SEATS['seat-3'], state: 'done', verdict: 'real' },
      { lens: 'reproduction', seat: SEATS['seat-1'], state: 'done', verdict: 'unjudged' }
    ],
    ...patch
  }
}

/** Discover revision 7 after Rank: one confirmed, one refuted, one repeat, one report item. */
export function discoverRunView(): LocalWorkflowView {
  return {
    ...workflowView(),
    preset: 'discover',
    revision: 7,
    state: 'completed',
    finishedAt: Date.now(),
    running: 0,
    queued: 0,
    actions: [],
    prompt: 'Find real bugs in the checkout flow',
    stages: [
      { id: 'scout', label: 'Scout', completed: 1, total: 1, failed: 0 },
      { id: 'find', label: 'Find', completed: 3, total: 4, failed: 1 },
      { id: 'verify', label: 'Verify', completed: 6, total: 6, failed: 0 },
      { id: 'rank', label: 'Rank', completed: 1, total: 1, failed: 0 }
    ],
    calls: [
      workflowCall('scout/map', 'seat-1'),
      workflowCall('find/r1/0/correctness', 'seat-2'),
      workflowCall('find/r1/0/security', 'seat-3', {
        state: 'failed',
        error: 'timed out after 20:00'
      }),
      workflowCall('rank/final', 'seat-1')
    ],
    result: { markdown: 'One defect held up.', sources: [], coverage: [] },
    discoverRun: {
      areas: [{ name: 'Checkout', files: ['src/checkout/pay.ts'], why: 'Charges cards' }],
      lenses: ['correctness', 'reliability', 'security'],
      round: 2,
      maxRounds: 3,
      findings: [
        finding('f1', {}),
        finding('f2', {
          title: 'Currency rounding loses a cent',
          location: 'src/checkout/total.ts:18',
          severity: 'medium',
          status: 'refuted',
          votes: []
        }),
        finding('f3', { duplicateOf: 'f1' })
      ],
      counts: { found: 3, duplicates: 1, verifying: 0, confirmed: 1, refuted: 1, unverified: 0 },
      report: {
        summary: 'One defect held up under verification.',
        items: [
          {
            rank: 1,
            title: 'Retry drops the idempotency key',
            location: 'src/checkout/pay.ts:142',
            severity: 'high',
            scenario: 'A timeout followed by a retry charges the card twice.',
            fix: 'Reuse the original key on retry.',
            findingIds: ['f1'],
            parallelSafe: true
          }
        ]
      },
      dropped: ['Round 3 skipped: the agent limit was reached.']
    }
  }
}
