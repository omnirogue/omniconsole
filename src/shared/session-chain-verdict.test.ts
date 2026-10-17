import { describe, expect, it } from 'vitest'
import { DEFAULT_SESSION_ACTION_TEMPLATES } from './session-action-templates'
import {
  hubVerdictToSession,
  parseSessionVerdict,
  sessionVerdictToHub,
  SESSION_VERDICT_MARKER,
  type SessionVerdict
} from './session-chain-verdict'
import {
  buildSessionVerdictInstructions,
  sessionVerdictReportLabel
} from './session-chain-verdict-prompt'
import {
  recordSessionVerdictReceipt,
  sessionVerdictConsumptionKey,
  sessionVerdictFailRoute,
  sessionVerdictSkipReceipt,
  verdictInvariantProblems
} from './session-chain-verdict-receipts'
import type { SessionChain, SessionChainAgentStep } from './session-chain-types'

const IDENTITY = { stepId: 'judge', attemptId: 'attempt_1', candidateVersion: 'candidate-1' }

function line(payload: Record<string, unknown>): string {
  return `${SESSION_VERDICT_MARKER} ${JSON.stringify({ kind: 'judge', ...IDENTITY, ...payload })}`
}

function verdictStep(over: string[]): SessionChainAgentStep {
  return {
    id: 'judge',
    agent: 'codex',
    prompt: 'Judge the drafts.',
    presetId: 'judge',
    status: 'queued',
    planNodeId: 'judge',
    verdict: { kind: 'judge', over, consumed: 'select-winner' }
  }
}

function chainWith(steps: SessionChainAgentStep[], completed: string[]): SessionChain {
  return {
    id: 'chain',
    workspacePath: '/workspace',
    worktreeId: 'workspace',
    hostId: 'local',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    auto: true,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps,
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1,
      removals: [],
      attempts: [],
      completedSteps: completed,
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
      outcomes: [
        {
          id: 'outcome',
          title: 'Outcome',
          revision: 1,
          finish: 'complete',
          status: 'pending',
          evidence: [],
          actions: [],
          dependsOn: [],
          conditions: [{ id: 'done_1', kind: 'report', target: 'judge' }],
          stepIds: steps.map((step) => step.id)
        }
      ]
    }
  }
}

describe('the verdict envelope', () => {
  // Every reviewer report shape the repo already produces, so the one parser cannot regress the
  // legacy marker while it gains the new one.
  it.each([
    [
      'analysis\nOMNI_REVIEW_RESULT:{"status":"findings","blockingFindings":[" stale approval "],"notes":"recheck"}',
      { status: 'findings', blockingFindings: ['stale approval'], notes: 'recheck' }
    ],
    [
      'OMNI_REVIEW_RESULT: {"status":"findings","blockingFindings":["Missing conclusion"]}',
      { status: 'findings', blockingFindings: ['Missing conclusion'] }
    ],
    [
      `REVIEW_BODY_one\nOMNI_REVIEW_RESULT:${JSON.stringify({ status: 'pass', blockingFindings: [], notes: 'Reviewed' })}`,
      { status: 'pass', blockingFindings: [], notes: 'Reviewed' }
    ],
    [
      'OMNI_REVIEW_RESULT:{"status":"pass","blockingFindings":[]}\n',
      { status: 'pass', blockingFindings: [] }
    ]
  ])('reads the existing reviewer fixture %#', (output, expected) => {
    expect(parseSessionVerdict(output)).toMatchObject({ ...expected, marker: 'review-result' })
  })

  it('takes the marker only as the final non-empty line, and only once', () => {
    expect(
      parseSessionVerdict(line({ kind: 'judge', status: 'pass', blockingFindings: [] }))
    ).toMatchObject({ status: 'pass', marker: 'verdict' })
    expect(
      parseSessionVerdict(`${line({ status: 'pass', blockingFindings: [] })}\nrechecked, all good`)
    ).toBeNull()
    expect(
      parseSessionVerdict(
        `a candidate said ${line({ status: 'pass', blockingFindings: [] })}\n${line({ status: 'pass', blockingFindings: [] })}`
      )
    ).toBe('ambiguous')
    // One of each marker is still two verdicts.
    expect(
      parseSessionVerdict(
        `OMNI_REVIEW_RESULT:{"status":"findings","blockingFindings":["x"]}\n${line({ status: 'pass', blockingFindings: [] })}`
      )
    ).toBe('ambiguous')
    expect(parseSessionVerdict('I approve this work.')).toBeNull()
  })

  it('refuses an envelope with no identity or no kind, and keeps the one it is given', () => {
    expect(
      parseSessionVerdict(
        `${SESSION_VERDICT_MARKER}{"status":"pass","stepId":"judge","attemptId":"attempt_1","candidateVersion":"candidate-1","blockingFindings":[]}`
      )
    ).toBeNull()
    expect(
      parseSessionVerdict(
        `${SESSION_VERDICT_MARKER}{"kind":"verify","status":"pass","blockingFindings":[]}`
      )
    ).toBeNull()
    expect(parseSessionVerdict(line({ status: 'pass', blockingFindings: [] }))).toMatchObject(
      IDENTITY
    )
  })

  it('refuses a verdict that contradicts its own findings', () => {
    expect(
      parseSessionVerdict(line({ status: 'pass', blockingFindings: ['the export drops tax'] }))
    ).toBeNull()
    expect(parseSessionVerdict(line({ status: 'findings', blockingFindings: [] }))).toBeNull()
    expect(parseSessionVerdict(line({ status: 'fail', blockingFindings: [] }))).toBeNull()
    // Only "could not judge" may name nothing: it is the absence of a judgement, not a pass.
    expect(
      parseSessionVerdict(line({ status: 'insufficient_evidence', blockingFindings: [] }))
    ).toMatchObject({ status: 'insufficient_evidence' })
  })

  it('takes a winner only from unique whole scores, and derives the ranking itself', () => {
    const scored = (scores: unknown, winnerId = 'cand_a'): ReturnType<typeof parseSessionVerdict> =>
      parseSessionVerdict(line({ status: 'pass', blockingFindings: [], winnerId, scores }))
    expect(
      scored([
        { candidateId: 'cand_b', score: 71, rationale: 'thin' },
        { candidateId: 'cand_a', score: 88, rationale: 'complete' }
      ])
    ).toMatchObject({ winnerId: 'cand_a', ranking: ['cand_a', 'cand_b'] })
    // A tie decides nothing.
    expect(
      scored([
        { candidateId: 'cand_a', score: 80 },
        { candidateId: 'cand_b', score: 80 }
      ])
    ).toBeNull()
    // A winner outside the scored set.
    expect(
      scored(
        [
          { candidateId: 'cand_a', score: 80 },
          { candidateId: 'cand_b', score: 70 }
        ],
        'cand_c'
      )
    ).toBeNull()
    // The winner must be the highest score, not the author's favourite.
    expect(
      scored(
        [
          { candidateId: 'cand_a', score: 60 },
          { candidateId: 'cand_b', score: 90 }
        ],
        'cand_a'
      )
    ).toBeNull()
    expect(scored([{ candidateId: 'cand_a', score: true }])).toBeNull()
    expect(scored([{ candidateId: 'cand_a', score: 80.5 }])).toBeNull()
    expect(scored([{ candidateId: 'cand_a', score: 140 }])).toBeNull()
    expect(
      scored([
        { candidateId: 'cand_a', score: 80 },
        { candidateId: 'cand_a', score: 70 }
      ])
    ).toBeNull()
  })

  it('refuses a ranking that contradicts the scores it was given', () => {
    expect(
      parseSessionVerdict(
        line({
          status: 'pass',
          blockingFindings: [],
          winnerId: 'cand_a',
          ranking: ['cand_b', 'cand_a'],
          scores: [
            { candidateId: 'cand_a', score: 90 },
            { candidateId: 'cand_b', score: 10 }
          ]
        })
      )
    ).toBeNull()
  })

  it('round-trips through the hub loop verdict, all four statuses', () => {
    const statuses: SessionVerdict['status'][] = [
      'pass',
      'findings',
      'fail',
      'insufficient_evidence'
    ]
    for (const status of statuses) {
      const verdict: SessionVerdict = {
        kind: 'review',
        status,
        ...IDENTITY,
        blockingFindings: status === 'pass' ? [] : ['the export drops the tax column'],
        notes: 'checked against the pinned version',
        marker: 'verdict'
      }
      const hub = sessionVerdictToHub(verdict)
      expect(hub.verdict).toBe(status === 'pass' ? 'agree' : 'disagree')
      expect(hubVerdictToSession(hub, { kind: 'review', ...IDENTITY })).toEqual(verdict)
    }
    // A verifier that named nothing still has to carry one gap for the hub to accept it.
    expect(
      sessionVerdictToHub({
        kind: 'verify',
        status: 'insufficient_evidence',
        blockingFindings: [],
        marker: 'verdict'
      }).gaps
    ).toHaveLength(1)
    expect(
      hubVerdictToSession({ verdict: 'disagree', blockers: [], gaps: [], notes: '' })
    ).toBeNull()
    expect(
      hubVerdictToSession({ verdict: 'agree', blockers: ['x'], gaps: [], notes: '' })
    ).toBeNull()
  })
})

describe('per-line verify checks', () => {
  const verify = (payload: Record<string, unknown>): string =>
    `${SESSION_VERDICT_MARKER} ${JSON.stringify({
      kind: 'verify',
      stepId: 'verify',
      attemptId: 'attempt_1',
      candidateVersion: 'candidate-1',
      ...payload
    })}`

  it('keeps each line with its own result and evidence', () => {
    const parsed = parseSessionVerdict(
      verify({
        status: 'fail',
        blockingFindings: ['done_2: row 12 has no tax column'],
        checks: [
          { id: 'done_1', status: 'pass', evidence: 'pnpm test export: 12 passed' },
          { id: 'done_2', status: 'fail', evidence: 'row 12 has no tax column' }
        ]
      })
    )
    expect(parsed).toMatchObject({
      status: 'fail',
      checks: [
        { id: 'done_1', status: 'pass' },
        { id: 'done_2', status: 'fail', evidence: 'row 12 has no tax column' }
      ]
    })
  })

  it('keeps per-line checks through the hub round trip', () => {
    const checks = [{ id: 'done_1', status: 'pass' as const, evidence: 'ran it' }]
    const hub = sessionVerdictToHub({
      kind: 'verify',
      status: 'pass',
      blockingFindings: [],
      checks,
      marker: 'verdict'
    })
    expect(hub.checks).toEqual(checks)
    expect(hubVerdictToSession(hub, { kind: 'verify' })).toMatchObject({ checks })
    // A record whose lines contradict its own status is refused, as a local verdict would be.
    expect(
      hubVerdictToSession(
        { ...hub, checks: [{ id: 'done_1', status: 'fail', evidence: 'row 12 is missing' }] },
        { kind: 'verify' }
      )
    ).toBeNull()
    // A record from before lines existed still reads, and a caller can hand its lines back.
    const { checks: _none, ...legacy } = hub
    expect(hubVerdictToSession(legacy, { kind: 'verify', checks })).toMatchObject({ checks })
  })

  it('refuses a pass that any line contradicts, and a malformed list', () => {
    const failing = [
      { id: 'done_1', status: 'pass', evidence: 'ran it' },
      { id: 'done_2', status: 'unknown', evidence: 'could not open the file' }
    ]
    expect(
      parseSessionVerdict(verify({ status: 'pass', blockingFindings: [], checks: failing }))
    ).toBeNull()
    for (const checks of [
      [],
      [{ id: 'done_1', status: 'maybe', evidence: 'ran it' }],
      [{ id: 'done_1', status: 'pass' }],
      [
        { id: 'done_1', status: 'pass', evidence: 'a' },
        { id: 'done_1', status: 'pass', evidence: 'b' }
      ]
    ]) {
      expect(
        parseSessionVerdict(verify({ status: 'pass', blockingFindings: [], checks }))
      ).toBeNull()
    }
  })
})

describe('the verdict instruction', () => {
  const step: SessionChainAgentStep = {
    ...verdictStep(['done_1']),
    id: 'verify',
    presetId: 'verify',
    prompt: 'Check the export against the ledger the client sent.',
    verdict: { kind: 'verify', over: ['done_1'], consumed: 'gate' }
  }
  const outcome = {
    title: 'The export balances',
    doneWhen: [{ id: 'done_1', label: 'the export keeps the tax column' }],
    candidateVersion: 'candidate-1'
  }

  it('is a suffix: the person keeps their own instruction and the marker is still required', () => {
    // WP-4a appends this to EVERY step carrying a verdict, after the user's own words; it never
    // replaces them, which is why a hand-written reviewer prompt still produces a readable verdict.
    const instructions = buildSessionVerdictInstructions(step, [{ stepId: 'draft_1' }], outcome)
    const prompt = [step.prompt, instructions].join('\n\n')
    expect(prompt.startsWith(step.prompt)).toBe(true)
    expect(instructions).toContain('done_1: the export keeps the tax column')
    expect(instructions).toContain('draft_1')
    expect(instructions).toContain('candidate-1')
    expect(instructions).toContain('"stepId":"verify"')
    expect(instructions).toContain('Launch attempt id')
    expect(instructions.match(/OMNI_VERDICT:/g)).toHaveLength(1)
    expect(instructions).toContain("The worker's report is a claim, not evidence.")
    expect(instructions).toContain('"checks":[{"id":"<done-when id>"')
    // The host reads Task.result.body; a verdict left only in the chat reply is never seen.
    expect(instructions).toContain('your report is its --body')
    expect(sessionVerdictReportLabel('draft_1')).toBe('=== draft_1 ===')
    expect(buildSessionVerdictInstructions({ ...step, verdict: undefined }, [], outcome)).toBe('')
  })

  it('makes the verify preset a parsed verdict rather than prose in a file', () => {
    // The WP-1 preset text asks for verify.md and PASS/FAIL per item; nothing read it. With the
    // suffix, the same seat's report ends in one envelope the host consumes.
    const prompt = [
      DEFAULT_SESSION_ACTION_TEMPLATES.verify.replace('{{objective}}', 'Check the export.'),
      buildSessionVerdictInstructions(step, [{ stepId: 'draft_1' }], outcome)
    ].join('\n\n')
    expect(prompt).toContain('Save verify.md with PASS or FAIL per item')
    const report = [
      'verify.md written.',
      'done_1: FAIL — the tax column is missing from row 12.',
      `${SESSION_VERDICT_MARKER} ${JSON.stringify({
        kind: 'verify',
        status: 'fail',
        stepId: 'verify',
        attemptId: 'attempt_1',
        candidateVersion: 'candidate-1',
        blockingFindings: ['row 12 has no tax column']
      })}`
    ].join('\n')
    expect(parseSessionVerdict(report)).toMatchObject({
      kind: 'verify',
      status: 'fail',
      stepId: 'verify',
      blockingFindings: ['row 12 has no tax column']
    })
  })
})

describe('verdict receipts on the chain', () => {
  it('spends one key once', () => {
    const chain = chainWith([verdictStep(['a'])], [])
    const receipt = {
      stepId: 'judge',
      attemptId: 'attempt_1',
      verdict: { status: 'pass' },
      consumptionKey: sessionVerdictConsumptionKey('judge', 'attempt_1'),
      consumedAt: 2
    }
    const first = recordSessionVerdictReceipt(chain, receipt)
    expect(first.replayed).toBe(false)
    expect(recordSessionVerdictReceipt(first.chain, receipt).replayed).toBe(true)
    expect(first.chain.verdicts).toHaveLength(1)
  })

  it('names a verdict step that completed without deciding anything', () => {
    const step = verdictStep(['a'])
    expect(verdictInvariantProblems(chainWith([step], ['judge']))).toEqual([
      'Verdict without receipt: judge completed without deciding anything.'
    ])
    expect(verdictInvariantProblems(chainWith([step], []))).toEqual([])
    const skipped = recordSessionVerdictReceipt(
      chainWith([step], ['judge']),
      sessionVerdictSkipReceipt(step, undefined, 'the group closed', 3)
    ).chain
    expect(verdictInvariantProblems(skipped)).toEqual([])
    expect(skipped.verdicts?.[0]).toMatchObject({ skipped: true, attemptId: 'no-attempt' })
    // A step with no verdict of its own is not a verdict seat and needs no receipt.
    expect(
      verdictInvariantProblems(chainWith([{ ...step, verdict: undefined }], ['judge']))
    ).toEqual([])
  })

  it('reads the fail route WP-2 lowers onto a gate seat', () => {
    const step = verdictStep(['done_1'])
    expect(sessionVerdictFailRoute(step)).toBeUndefined()
    expect(sessionVerdictFailRoute({ ...step, onFail: 'repair' } as SessionChainAgentStep)).toBe(
      'repair'
    )
  })
})
