import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { holdoutArm, main, planCohort } from './omnirogue-winback-cohort.mjs'

const NOW = '2026-10-17T12:00:00Z'
const EXAMPLE = JSON.parse(
  readFileSync(new URL('./omnirogue-winback-cohort.example.json', import.meta.url))
)
const sendUser = Array.from({ length: 20 }, (_, i) => `user-${i}`).find(
  (id) => holdoutArm(id) === 'send'
)
const holdoutUser = Array.from({ length: 20 }, (_, i) => `user-${i}`).find(
  (id) => holdoutArm(id) === 'holdout'
)

function candidate(patch = {}) {
  return { ...structuredClone(EXAMPLE.candidates[0]), userId: sendUser, ...patch }
}

function plan(candidates, patch = {}, options = {}) {
  return planCohort({ ...EXAMPLE, candidates, ...patch }, { mode: 'shadow', now: NOW, ...options })
}

function row(patch = {}) {
  return plan([candidate(patch)]).rows[0]
}

test('default off does not evaluate or read input', () => {
  assert.deepEqual(planCohort(null), { schemaVersion: 1, mode: 'off', rows: [], counts: {} })
  let output = ''
  assert.equal(
    main(
      ['--input', 'missing'],
      {},
      {
        read: () => assert.fail('off mode must not read input'),
        out: (text) => {
          output += text
        }
      }
    ),
    0
  )
  assert.equal(JSON.parse(output).mode, 'off')
  assert.throws(() => plan([], {}, { mode: 'send' }), /sending is unsupported/)
})

test('UTC calendar days are measured from access end, never cancel request', () => {
  for (const [endedAt, step] of [
    ['2026-10-03T23:59:59Z', 14],
    ['2026-09-17T00:00:00Z', 30],
    ['2026-08-18T12:00:00Z', 60]
  ]) {
    assert.equal(row({ endedAt }).status, 'shadow')
    assert.equal(row({ endedAt }).step, step)
  }
  assert.equal(
    row({ endedAt: '2026-10-04T12:00:00Z', cancelledAt: '2026-10-03T12:00:00Z' }).status,
    'not_due'
  )
  assert.equal(row({ endedAt: '2026-10-02T12:00:00Z' }).status, 'not_due')
})

test('suppresses every required account, payment, and marketing risk independently', () => {
  const cases = {
    accountExists: [false, 'account_deleted'],
    paidPlan: [true, 'paid_plan'],
    lifetime: [true, 'lifetime'],
    liveSubscription: [true, 'live_subscription'],
    refundOrDispute: [true, 'refund_or_dispute'],
    pendingRefund: [true, 'pending_refund'],
    unsubscribed: [true, 'unsubscribed'],
    bounced: [true, 'bounced'],
    complained: [true, 'complained'],
    isAdmin: [true, 'admin']
  }
  for (const [key, [value, reason]] of Object.entries(cases)) {
    const result = row({ checks: { ...candidate().checks, [key]: value } })
    assert.equal(result.status, 'suppressed', key)
    assert.deepEqual(result.reasons, [reason], key)
    for (const unverified of [undefined, null, 0, 'false']) {
      assert.ok(
        row({ checks: { ...candidate().checks, [key]: unverified } }).reasons.includes(
          `unverified_${key}`
        )
      )
    }
  }
  assert.equal(row({ checks: null }).reasons.length, Object.keys(cases).length)
})

test('suppresses non-voluntary ends and malformed or absent identity/end evidence', () => {
  for (const patch of [
    { cancellationReason: 'payment_failed' },
    { eventType: 'customer.subscription.updated' },
    { endedAt: null },
    { endedAt: '2026-10-18T00:00:00Z' },
    { endedAt: '2026-02-30T00:00:00Z' },
    { endedAt: '2026-10-03' },
    { userId: '' },
    { customerId: null },
    { subscriptionId: 'secret@example.invalid' }
  ]) {
    assert.equal(row(patch).status, 'suppressed')
  }
  for (const malformed of [null, 42, {}, []]) {
    assert.equal(plan([malformed]).rows[0].status, 'suppressed')
  }
})

test('re-checks suppression on each run and reports every reason', () => {
  const snapshot = candidate()
  assert.equal(plan([snapshot]).rows[0].status, 'shadow')
  snapshot.checks.refundOrDispute = true
  snapshot.checks.unsubscribed = true
  assert.deepEqual(plan([snapshot]).rows[0].reasons, ['refund_or_dispute', 'unsubscribed'])
})

test('12-month sequence exclusion includes boundary and rejects unknown history', () => {
  assert.equal(row({ previousSequenceAt: '2025-10-17T12:00:00Z' }).status, 'suppressed')
  assert.equal(row({ previousSequenceAt: '2025-10-17T11:59:59Z' }).status, 'shadow')
  for (const previousSequenceAt of [undefined, 'invalid', '2027-10-17T12:00:00Z']) {
    assert.ok(row({ previousSequenceAt }).reasons.includes('unverified_previous_sequence'))
  }
  const leap = plan(
    [candidate({ endedAt: '2024-02-15T12:00:00Z', previousSequenceAt: '2023-02-28T12:00:00Z' })],
    { checkedAt: '2024-02-29T12:00:00Z' },
    { now: '2024-02-29T12:00:00Z' }
  )
  assert.deepEqual(leap.rows[0].reasons, ['recent_sequence'])
})

test('all tracks reuse the audit mapping and 45-day reason precedence', () => {
  const cases = {
    too_expensive: 'too_expensive',
    not_using_enough: 'unused_credits',
    credits_confusing: 'unused_credits',
    found_alternative: 'switching',
    technical_problems: 'technical',
    quality_issues: 'technical',
    one_project: 'project_done',
    just_testing: 'just_testing',
    other: 'generic',
    not_given: 'generic',
    __unexpected: 'generic',
    constructor: 'generic'
  }
  for (const [reasonCategory, track] of Object.entries(cases)) {
    assert.equal(row({ reasonCategory, stripeFeedback: 'switched_service' }).track, track)
  }
  const feedbacks = {
    too_expensive: 'too_expensive',
    unused: 'unused_credits',
    switched_service: 'switching',
    low_quality: 'technical',
    too_complex: 'technical',
    other: 'generic',
    constructor: 'generic'
  }
  for (const [stripeFeedback, track] of Object.entries(feedbacks)) {
    assert.equal(row({ reasonCategory: null, stripeFeedback }).track, track)
  }
  for (const reasonCreatedAt of ['2026-08-18T11:59:59Z', '2026-10-04T12:00:00Z', null]) {
    assert.equal(row({ reasonCreatedAt, stripeFeedback: 'unused' }).track, 'unused_credits')
  }
  assert.equal(
    row({ reasonCreatedAt: '2026-08-19T12:00:00Z', stripeFeedback: 'unused' }).track,
    'too_expensive'
  )
})

test('stable holdout survives plan, reason, and subscription changes', () => {
  assert.equal(holdoutArm('user-0'), 'send')
  assert.equal(holdoutArm('user-1'), 'holdout')
  assert.equal(row({ userId: holdoutUser }).status, 'holdout')
  assert.equal(
    row({ userId: holdoutUser, subscriptionId: 'sub_new', reasonCategory: 'one_project' }).status,
    'holdout'
  )
  const count = Array.from({ length: 10000 }, (_, i) => holdoutArm(`cohort-${i}`)).filter(
    (arm) => arm === 'holdout'
  ).length
  assert.ok(count > 1800 && count < 2200, `holdout count ${count}`)
})

test('processed steps are skipped, with no unknown history defaulting to empty', () => {
  assert.equal(row({ completedSteps: [14] }).status, 'already_processed')
  assert.equal(row({ completedSteps: [30] }).status, 'shadow')
  assert.equal(row({ endedAt: '2026-09-17T12:00:00Z', completedSteps: [14] }).status, 'shadow')
  for (const completedSteps of [undefined, null, ['14'], [15]]) {
    assert.ok(row({ completedSteps }).reasons.includes('unverified_steps'))
  }
})

test('duplicate or conflicting user, Stripe customer, and subscription rows all suppress', () => {
  for (const key of ['userId', 'customerId', 'subscriptionId']) {
    const second = candidate({
      userId: 'other-user',
      customerId: 'cus_other',
      subscriptionId: 'sub_other'
    })
    second[key] = candidate()[key]
    const result = plan([candidate(), second])
    assert.deepEqual(result.counts, { suppressed: 2 })
    assert.ok(result.rows.every((item) => item.reasons.includes('duplicate_identity')))
  }
})

test('requires versioned, recent snapshot evidence and timezone-independent UTC timestamps', () => {
  for (const checkedAt of [
    null,
    '2026-10-16T11:59:59Z',
    '2026-10-17T12:00:01Z',
    '2026-10-17T12:00:00'
  ]) {
    assert.throws(() => plan([], { checkedAt }), /preceding 24 hours/)
  }
  assert.deepEqual(plan([], { checkedAt: '2026-10-16T12:00:00Z' }).rows, [])
  assert.throws(() => plan([], { schemaVersion: 2 }), /schemaVersion/)
  assert.throws(() => plan(null), /candidates array/)
  assert.throws(() => plan([], {}, { now: 'invalid' }), /UTC ISO/)
})

test('CLI parses shadow mode, opt-out override, errors, and safe output', () => {
  function cli(args, env = {}, input = EXAMPLE) {
    let stdout = '',
      stderr = ''
    const code = main(args, env, {
      read: () => (typeof input === 'string' ? input : JSON.stringify(input)),
      out: (text) => {
        stdout += text
      },
      err: (text) => {
        stderr += text
      }
    })
    return { code, stdout, stderr }
  }
  const result = cli(['--input', 'snapshot.json', '--now', NOW], {
    OMNIROGUE_CANCEL_WINBACK_MODE: 'shadow'
  })
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).rows.length, 1)
  assert.equal(cli(['--mode', 'off'], { OMNIROGUE_CANCEL_WINBACK_MODE: 'shadow' }).code, 0)
  assert.match(cli(['--help']).stdout, /cannot send email/)
  for (const args of [
    ['--mode', 'send'],
    ['--mode', 'shadow'],
    ['--bogus'],
    ['--mode'],
    ['--mode', '--input']
  ]) {
    assert.equal(cli(args).code, 1)
  }
  const invalid = cli(
    ['--mode', 'shadow', '--input', 'snapshot.json'],
    {},
    '{"email":"private@example.invalid",broken}'
  )
  assert.equal(invalid.code, 1)
  assert.equal(invalid.stdout, '')
  assert.doesNotMatch(invalid.stderr, /private@example/)
})
