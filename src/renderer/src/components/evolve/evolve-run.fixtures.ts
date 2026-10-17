import type { EvolveRunRecord } from '../../../../shared/evolve-workflow'

const RUBRIC_SHA = 'a'.repeat(64)

/** A running email-smoke run on mw0001, seeded from an earlier run, with one promotion record. */
export function evolveRunFixture(patch: Partial<EvolveRunRecord> = {}): EvolveRunRecord {
  return {
    id: 'evo_00000000-0000-4000-8000-000000000001',
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:05:00.000Z',
    state: 'running',
    conversationId: 'evolve-tab',
    worktreeId: 'repo::/workspace',
    request: { target: 'email-smoke', seedFrom: 'email' },
    spec: 'jevlab/evolve/email/smoke.yaml',
    checkout: '~/Repos/jev-lab-evolve',
    submittedBy: 'sal',
    placement: {
      runsOn: 'fleet',
      mode: 'remote-runtime',
      host: { name: 'mw0001', machine: 'mw0001', cores: 10, loadPerCore: 0.1, readAt: 0 }
    },
    host: 'mw0001',
    ledgerRunId: 'run_7f3a',
    submitted: { specSha: 'spec-sha', target: 'email', iterations: 8, usdCap: 2 },
    worker: { pid: 4242, directory: '/tmp/evo', startedAt: '2026-09-30T10:00:05.000Z' },
    contact: { verdict: 'live', at: '2026-09-30T10:05:00.000Z' },
    ledger: {
      run_id: 'run_7f3a',
      found: true,
      target: 'email',
      status: 'running',
      spec_sha: 'spec-sha',
      budget: { group: 'evolve-email', run_cap_usd: 2, spend_usd: 0.42 },
      times: { heartbeat_age_s: 12 },
      iterations: { requested: 8, evaluated_mutations: 3 },
      candidates: { total: 5, by_role: {}, by_status: { scored: 4, pending: 1 } },
      best_so_far: { candidate_id: 'cand_best', program_sha: 'p1', combined_score: 0.8123 },
      seed_from: 'email',
      rubric_from: null,
      rubrics: [{ stage: 'judge', type: 'llm', rubric_sha: RUBRIC_SHA }],
      seeded: [
        {
          candidate_id: 'cand_seed',
          source_run_id: 'run_earlier',
          source_candidate_id: 'cand_old',
          program_sha: 'p0',
          prior_combined_score: 0.75,
          prior_promoted: true,
          status: 'scored',
          combined_score: 0.77
        }
      ],
      promotions: [
        {
          candidate_id: 'cand_promo',
          decision: 'eligible',
          hard_pass: true,
          intervals_pass: false,
          availability: 0.99
        }
      ]
    },
    events: [
      { at: '2026-09-30T10:00:00.000Z', text: 'Placed on mw0001' },
      { at: '2026-09-30T10:00:05.000Z', text: 'Worker started' }
    ],
    ...patch
  }
}
