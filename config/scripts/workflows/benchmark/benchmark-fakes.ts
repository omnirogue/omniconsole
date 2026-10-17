import type {
  WorkflowRunResult,
  WorkflowRunTarget
} from '../../../../src/shared/workflow-run-result'

/** A recorded-shape `omni workflow run --json` result for the kit's tests; nothing here runs. */
export function fakeTarget(
  key: string,
  location: string,
  title: string,
  extra: Partial<WorkflowRunTarget> = {}
): WorkflowRunTarget {
  return {
    step: 'verify',
    round: 1,
    key,
    title,
    location,
    severity: 'high',
    tally: 'confirmed',
    votes: ['pass'],
    repeats: 1,
    detail: title,
    ...extra
  }
}

export function fakeRun(
  targets: WorkflowRunTarget[],
  extra: Partial<WorkflowRunResult> = {}
): WorkflowRunResult {
  return {
    worktreeId: 'wt',
    conversationId: 'tab',
    executionId: '3f9a1c2e-0000-4000-8000-000000000000',
    template: 'discover',
    state: 'completed',
    markdown: '## Findings',
    results: { steps: [], targets, standings: [] },
    gaps: [],
    timing: { wallClockMs: 600_000, followedMs: 601_000 },
    calls: [],
    usage: {
      tokens: { kind: 'reported', input: 90_000, output: 10_000 },
      callsWithTokens: 0,
      callsTotal: 0,
      costUsd: 'unknown',
      costSource: 'unknown'
    },
    ...extra
  }
}

/** A Discover run that finds seven seeded bugs (one twice), a decoy, and one thing not in the key. */
export const RECORDED_DISCOVER_RUN = fakeRun([
  fakeTarget('t1', 'src/payments.ts:44-70', 'Capture failures are swallowed and recorded as paid', {
    severity: 'critical',
    jevScore: 3.8
  }),
  fakeTarget(
    't2',
    'src/inventory.ts:58-75',
    'Race: concurrent reserve oversells stock without the SKU lock',
    { jevScore: 3.5 }
  ),
  fakeTarget(
    't3',
    'src/orders.ts:55',
    'Missing await on inventory.reserve; order marked reserved',
    { jevScore: 3.6 }
  ),
  fakeTarget('t4', 'src/price-cache.ts:33', 'Cache key ignores currency, serving the wrong price', {
    jevScore: 2.9
  }),
  fakeTarget('t5', 'src/orders.ts:119', 'Pagination drops the last order of every page', {
    severity: 'medium',
    jevScore: 2.5
  }),
  fakeTarget('t6', 'orders.ts line 56', 'reserve() promise not awaited', { jevScore: 3.1 }),
  fakeTarget('t7', 'src/money.ts:58', 'allocate loop is off by one', {
    severity: 'low',
    jevScore: 1.2
  }),
  fakeTarget('t8', 'src/db.ts:100-105', 'newId counter is not unique across processes', {
    severity: 'low',
    jevScore: 1.5
  }),
  fakeTarget('t9', 'src/job-queue.ts:103', 'active never decremented when journal.delete throws', {
    tally: 'refuted',
    jevScore: 2
  }),
  fakeTarget('t10', 'src/http-handlers.ts:61', 'limit query param is unchecked', {
    severity: 'medium',
    tally: 'unverified',
    unchecked: true,
    screened: true,
    jevScore: 0.6
  }),
  fakeTarget(
    't11',
    'src/payments.ts:87',
    'Refund compared with capturedCents, not the remaining amount',
    { jevScore: 3.3 }
  )
])

/** The same findings from one Quick Discover reader: every target unverified, single pass. */
export const QUICK_DISCOVER_RUN = fakeRun(
  RECORDED_DISCOVER_RUN.results.targets.map((target) => ({
    ...target,
    step: 'find',
    tally: 'unverified' as const,
    votes: [],
    singlePass: true as const
  })),
  { template: 'quick-discover' }
)
