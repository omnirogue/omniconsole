import { describe, expect, it } from 'vitest'
import type { EvolveWorkflowRunRecord } from '../../../shared/evolve-workflow'
import type { OmniRogueCreditBalance } from '../../../shared/omnirogue-account'
import {
  createHostedImproveRequest,
  hostedImproveProposal,
  HostedImproveCreditError,
  preflightHostedImproveCredits,
  type HostedImproveCreditQuote,
  type HostedImprovePromotionSummary,
  type HostedImproveRequest,
  type ImproveRunResult
} from './hosted-improve-bridge'

const balance: OmniRogueCreditBalance = {
  availableCredits: 100,
  reservedCredits: 80,
  totalCredits: 180,
  updatedAt: '2026-10-16T12:00:00Z'
}
const quote: HostedImproveCreditQuote = {
  executionTier: 'hosted_super_intelligence',
  estimatedCredits: 100
}
const options = { request: { target: 'spec' as const, specPath: 'workflow.yaml' }, quote, balance }

function local(): ImproveRunResult {
  return {
    runId: 'local-improve-42',
    bestCandidate: { id: 'local-winner', kind: 'prompt', text: '  Best local prompt\n' },
    rubricCriteria: [
      { id: 'accuracy', instructions: 'All claims are supported.', weight: 3 },
      { id: 'clarity', instructions: 'Use plain language.', weight: 1 }
    ],
    datasetCases: [
      { id: 'case-1', input: 'Explain the result.', expectedOutput: 'A supported explanation.' }
    ]
  }
}

function run(): EvolveWorkflowRunRecord & { request: HostedImproveRequest } {
  return {
    id: 'evo_00000000-0000-0000-0000-000000000001',
    createdAt: balance.updatedAt,
    updatedAt: balance.updatedAt,
    state: 'done',
    request: createHostedImproveRequest(local(), options),
    spec: 'workflow.yaml',
    checkout: '/host/evolve',
    submittedBy: 'test',
    placement: { runsOn: 'fleet', mode: 'remote-runtime' },
    host: 'hosted',
    ledgerRunId: 'hosted-ledger-42',
    events: []
  }
}

function summary(): HostedImprovePromotionSummary {
  return {
    runId: run().id,
    seedFromRunId: 'local-improve-42',
    candidate: { id: 'hosted-winner', kind: 'prompt', text: 'Better hosted prompt\n' },
    promoted: true,
    pairwiseTournamentWinRate: 0.875,
    blindCrossFamilyAuditStatus: 'passed',
    creditsSpent: 73.5
  }
}

describe('hosted Improve seeding', () => {
  it.each(['hosted_super_intelligence', 'hosted_pro'] as const)(
    'seeds %s from the local winner',
    (executionTier) => {
      const seed = local()
      const request = createHostedImproveRequest(seed, {
        ...options,
        quote: { ...quote, executionTier }
      })
      expect(request).toEqual({
        target: 'spec',
        specPath: 'workflow.yaml',
        runsOn: 'hosted',
        executionTier,
        seedFromRunId: seed.runId,
        seedCandidateId: seed.bestCandidate.id,
        incumbentKind: 'prompt',
        initialIncumbentText: seed.bestCandidate.text,
        rubricCriteria: seed.rubricCriteria,
        rubricWeights: { accuracy: 3, clarity: 1 },
        datasetCases: seed.datasetCases,
        creditBudgetQuote: { ...quote, executionTier }
      })
    }
  )

  it.each(['markdown', 'script'] as const)('preserves %s content without reformatting', (kind) => {
    const seed = local()
    seed.bestCandidate = { id: 'best', kind, text: '\treturn "雪";\r\n' }
    const request = createHostedImproveRequest(seed, options)
    expect(request.incumbentKind).toBe(kind)
    expect(request.initialIncumbentText).toBe(seed.bestCandidate.text)
  })
  it('copies mutable inputs and retains selected launch context', () => {
    const seed = local()
    const mutableQuote = { ...quote }
    const request = createHostedImproveRequest(seed, {
      ...options,
      quote: mutableQuote,
      request: { ...options.request, worktreeId: 'folder:/work', conversationId: 'conversation-1' }
    })
    seed.rubricCriteria[0].weight = 99
    seed.datasetCases[0].input = 'Changed'
    seed.bestCandidate.text = 'Changed'
    mutableQuote.estimatedCredits = 1
    expect(request.rubricCriteria[0].weight).toBe(3)
    expect(request.datasetCases[0].input).toBe('Explain the result.')
    expect(request.initialIncumbentText).toBe('  Best local prompt\n')
    expect(request.creditBudgetQuote.estimatedCredits).toBe(100)
    expect(request.worktreeId).toBe('folder:/work')
    expect(request.conversationId).toBe('conversation-1')
  })
  it('rejects missing winners and duplicate or ineffective rubric criteria', () => {
    const seed = local()
    seed.bestCandidate.text = '   '
    expect(() => createHostedImproveRequest(seed, options)).toThrow('Candidate text')
    seed.bestCandidate.text = 'winner'
    seed.rubricCriteria.push({ ...seed.rubricCriteria[0] })
    expect(() => createHostedImproveRequest(seed, options)).toThrow('unique')
    seed.rubricCriteria = [{ id: 'empty', instructions: 'Check', weight: 0 }]
    expect(() => createHostedImproveRequest(seed, options)).toThrow('positive')
    seed.rubricCriteria = []
    expect(() => createHostedImproveRequest(seed, options)).toThrow('criterion')
  })
  it('rejects duplicate cases and invalid spec paths', () => {
    const seed = local()
    seed.datasetCases.push({ ...seed.datasetCases[0] })
    expect(() => createHostedImproveRequest(seed, options)).toThrow('Dataset case IDs')
    expect(() =>
      createHostedImproveRequest(local(), {
        ...options,
        request: { target: 'spec', specPath: '../escape.yaml' }
      })
    ).toThrow()
  })
})

describe('hosted Improve credit preflight', () => {
  it('accepts exact available balance without counting reservations twice', () => {
    expect(() => preflightHostedImproveCredits(balance, quote)).not.toThrow()
    const empty = { ...balance, availableCredits: 0 }
    expect(() =>
      preflightHostedImproveCredits(empty, { ...quote, estimatedCredits: 0 })
    ).not.toThrow()
  })
  it('fails before conversion and gives the exact top-up shortfall', () => {
    const seed = local()
    seed.bestCandidate.text = ''
    const prepare = () =>
      createHostedImproveRequest(seed, {
        ...options,
        balance: { ...balance, availableCredits: 25.5 }
      })
    expect(prepare).toThrow(HostedImproveCreditError)
    expect(prepare).toThrow('Top up at least 74.5 OmniRogue credits')
    try {
      prepare()
    } catch (error) {
      expect(error).toMatchObject({
        code: 'insufficient_credits',
        topUpCredits: 74.5,
        spendableCredits: 25.5
      })
    }
  })
  it.each([Number.NaN, Infinity, -1])('rejects invalid credit values: %s', (value) => {
    expect(() =>
      preflightHostedImproveCredits(balance, { ...quote, estimatedCredits: value })
    ).toThrow()
    expect(() =>
      preflightHostedImproveCredits({ ...balance, availableCredits: value }, quote)
    ).toThrow()
  })
})

describe('hosted Improve proposals', () => {
  it('returns a review patch and the complete hosted receipt', () => {
    const record = run()
    const promotion = summary()
    const proposal = hostedImproveProposal(record, promotion)!
    expect(proposal.candidate).toEqual(promotion.candidate)
    expect(proposal.originalText).toBe(record.request.initialIncumbentText)
    expect(proposal.patch).toBe(
      '--- a/workflow\n+++ b/workflow\n@@ -1,1 +1,1 @@\n-  Best local prompt\n+Better hosted prompt\n'
    )
    expect(proposal.provenance).toEqual({
      localRunId: 'local-improve-42',
      localCandidateId: 'local-winner',
      hostedRunId: record.id,
      ledgerRunId: 'hosted-ledger-42',
      hostedCandidateId: 'hosted-winner',
      executionTier: 'hosted_super_intelligence',
      pairwiseTournamentWinRate: 0.875,
      blindCrossFamilyAuditStatus: 'passed',
      creditsSpent: 73.5,
      creditBudgetQuote: quote
    })
    promotion.candidate.text = 'Changed'
    record.request.creditBudgetQuote.estimatedCredits = 0
    expect(proposal.candidate.text).toBe('Better hosted prompt\n')
    expect(proposal.provenance.creditBudgetQuote.estimatedCredits).toBe(100)
  })
  it.each(['starting', 'running', 'unverifiable', 'failed', 'stopped'] as const)(
    'refuses %s runs',
    (state) => {
      expect(() => hostedImproveProposal({ ...run(), state }, summary())).toThrow(
        'finish successfully'
      )
    }
  )

  it('refuses a running ledger even when the local record says done', () => {
    const record = run()
    record.ledger = {
      run_id: 'hosted-ledger-42',
      found: true,
      target: 'spec',
      status: 'running',
      spec_sha: 'sha'
    }
    expect(() => hostedImproveProposal(record, summary())).toThrow('finish successfully')
  })
  it.each(['runId', 'seedFromRunId'] as const)('rejects a mismatched %s', (key) => {
    expect(() => hostedImproveProposal(run(), { ...summary(), [key]: 'wrong-run' })).toThrow(
      'does not belong'
    )
  })
  it('returns no proposal when the incumbent was kept', () => {
    expect(hostedImproveProposal(run(), { ...summary(), promoted: false })).toBeNull()
  })
  it.each(['failed', 'unavailable', 'not_run'] as const)(
    'preserves %s audit evidence without granting approval',
    (blindCrossFamilyAuditStatus) => {
      const proposal = hostedImproveProposal(run(), {
        ...summary(),
        blindCrossFamilyAuditStatus,
        pairwiseTournamentWinRate: null
      })!
      expect(proposal.provenance.blindCrossFamilyAuditStatus).toBe(blindCrossFamilyAuditStatus)
      expect(proposal.provenance.pairwiseTournamentWinRate).toBeNull()
    }
  )

  it.each([Number.NaN, Infinity, -0.1, 1.1])(
    'refuses invalid win rates: %s',
    (pairwiseTournamentWinRate) => {
      expect(() =>
        hostedImproveProposal(run(), { ...summary(), pairwiseTournamentWinRate })
      ).toThrow('win rate')
    }
  )

  it('refuses invalid spending, changed candidate kinds and mismatched quote tiers', () => {
    expect(() => hostedImproveProposal(run(), { ...summary(), creditsSpent: Number.NaN })).toThrow(
      'Credits spent'
    )
    expect(() =>
      hostedImproveProposal(run(), {
        ...summary(),
        candidate: { ...summary().candidate, kind: 'script' }
      })
    ).toThrow('candidate kind')
    const record = run()
    record.request.creditBudgetQuote.executionTier = 'hosted_pro'
    expect(() => hostedImproveProposal(record, summary())).toThrow('credit quote')
  })
  it('preserves missing final newlines and handles unchanged text', () => {
    const record = run()
    record.request.initialIncumbentText = 'old\nlast'
    const promotion = summary()
    promotion.candidate.text = 'new\nlast'
    expect(hostedImproveProposal(record, promotion)!.patch).toBe(
      [
        '--- a/workflow',
        '+++ b/workflow',
        '@@ -1,2 +1,2 @@',
        '-old',
        '-last',
        '\\ No newline at end of file',
        '+new',
        '+last',
        '\\ No newline at end of file',
        ''
      ].join('\n')
    )
    promotion.candidate.text = record.request.initialIncumbentText
    expect(hostedImproveProposal(record, promotion)!.patch).toBe('')
  })
})
