import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { auditExecutiveVideoCosts as audit, main } from './executive-video-cost-audit.mjs'

const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function attempt(overrides = {}) {
  return {
    accountId: 'account-1',
    billingPeriodId: 'period-1',
    jobId: 'job-1',
    provider: 'openrouter',
    requestId: 'request-1',
    status: 'succeeded',
    billingStatus: 'reconciled',
    actualCostUsd: '1.50',
    reservedCostUsd: '3',
    ...overrides
  }
}

function document(...attempts) {
  return { schemaVersion: 1, attempts }
}

function run(args) {
  const output = []
  const code = main(args, {
    log: (value) => output.push(value),
    error: (value) => output.push(value)
  })
  return { code, value: JSON.parse(output[0]) }
}

function fixture(content) {
  const directory = mkdtempSync(join(tmpdir(), 'executive-video-audit-'))
  directories.push(directory)
  const file = join(directory, 'attempts.json')
  writeFileSync(file, content)
  return file
}

test('disabled by default without reading the supplied file', () => {
  const result = run(['--input', 'missing.json'])
  assert.equal(result.code, 2)
  assert.equal(result.value.assessment, 'disabled')
})

test('deduplicates winning-take and cost-log copies without double-counting settled reservations', () => {
  const result = audit(
    document(attempt({ source: 'api_cost_log' }), attempt({ source: 'takes' })),
    '65'
  )
  assert.equal(result.uniqueAttempts, 1)
  assert.equal(result.duplicateRows, 1)
  assert.equal(result.periods[0].committedCostUsd, '1.500000')
  assert.equal(result.periods[0].outstandingReservationUsd, '0.000000')
  assert.equal(result.assessment, 'reconciled')
})

test('failed attempts retain their confirmed spend', () => {
  const result = audit(
    document(attempt({ status: 'failed' }), attempt({ requestId: 'retry' })),
    '65'
  )
  assert.equal(result.periods[0].confirmedCostUsd, '3.000000')
  assert.equal(result.assessment, 'reconciled')
})

test('unknown failed or pending provider costs retain reservations and require review', () => {
  for (const status of ['failed', 'pending', 'cancelled', 'succeeded']) {
    const result = audit(
      document(attempt({ status, billingStatus: 'pending', actualCostUsd: null })),
      '65'
    )
    assert.equal(result.assessment, 'review_required')
    assert.equal(result.periods[0].confirmedCostUsd, '0.000000')
    assert.equal(result.periods[0].outstandingReservationUsd, '3.000000')
    assert.equal(result.periods[0].issues[0].code, 'unresolved_provider_cost')
  }
})

test('flags double-billed provider legs and more than two attempts per job', () => {
  const result = audit(
    document(attempt(), attempt({ provider: 'fal' }), attempt({ requestId: 'third' })),
    '65'
  )
  assert.equal(result.periods[0].confirmedCostUsd, '4.500000')
  assert.deepEqual(
    result.periods[0].issues.map((issue) => issue.code),
    ['attempt_limit_exceeded', 'multiple_billed_providers']
  )
})

test('confirmed zero-cost failures allow a reconciled fallback without a double-billed issue', () => {
  const result = audit(
    document(attempt({ status: 'failed', actualCostUsd: '0' }), attempt({ provider: 'fal' })),
    '65'
  )
  assert.equal(result.assessment, 'reconciled')
})

test('same requestId at different providers represents separate payable attempts', () => {
  const result = audit(document(attempt(), attempt({ provider: 'fal', jobId: 'other-job' })), '65')
  assert.equal(result.uniqueAttempts, 2)
  assert.equal(result.periods[0].committedCostUsd, '3.000000')
})

test('budgets isolate accounts and periods and include unresolved spend', () => {
  const result = audit(
    document(
      attempt({ actualCostUsd: '64' }),
      attempt({ requestId: 'pending', billingStatus: 'pending', actualCostUsd: null }),
      attempt({ accountId: 'other', requestId: 'other' }),
      attempt({ billingPeriodId: 'next', requestId: 'next' })
    ),
    '65'
  )
  assert.equal(result.periods[0].committedCostUsd, '67.000000')
  assert.equal(result.periods[0].issues.at(-1).code, 'budget_exceeded')
  assert.equal(result.periods[1].issues.length, 0)
  assert.equal(result.periods[2].issues.length, 0)
})

test('uses exact decimal arithmetic at budget boundaries', () => {
  const input = document(
    attempt({ actualCostUsd: '0.1' }),
    attempt({ requestId: 'second', actualCostUsd: '0.2' })
  )
  assert.equal(audit(input, '0.3').assessment, 'reconciled')
  assert.equal(audit(input, '0.299999').assessment, 'review_required')
})

test('rejects conflicting duplicated costs, state, identity and reservations', () => {
  for (const change of [
    { actualCostUsd: '2' },
    { status: 'failed' },
    { jobId: 'other' },
    { accountId: 'other' },
    { billingPeriodId: 'other' },
    { reservedCostUsd: '4' }
  ]) {
    assert.throws(() => audit(document(attempt(), attempt(change)), '65'), /conflicting rows/)
  }
})

test('rejects malformed or unconfirmed money and identifiers', () => {
  for (const change of [
    { actualCostUsd: null },
    { actualCostUsd: -1 },
    { actualCostUsd: 'NaN' },
    { actualCostUsd: '1e3' },
    { actualCostUsd: '0.0000001' },
    { actualCostUsd: '-1' },
    { requestId: '' },
    { accountId: 'private@example.com' },
    { provider: 'bad provider' },
    { status: 'unknown' },
    { billingStatus: 'estimated' },
    { status: 'pending' },
    { billingStatus: 'pending', actualCostUsd: '1' },
    { billingStatus: 'pending', actualCostUsd: null, reservedCostUsd: '0' },
    { reservedCostUsd: null }
  ]) {
    assert.throws(() => audit(document(attempt(change)), '65'))
  }
})

test('rejects empty, unversioned or oversized exports and invalid budgets', () => {
  for (const input of [
    null,
    {},
    document(),
    document(null),
    { schemaVersion: 2, attempts: [attempt()] },
    { schemaVersion: 1, attempts: Array(100_001).fill(attempt()) }
  ]) {
    assert.throws(() => audit(input, '65'))
  }
  for (const budget of ['0', '-1', 'Infinity', undefined]) {
    assert.throws(() => audit(document(attempt()), budget))
  }
})

test('CLI returns review code and leaves its export unchanged', () => {
  const content = JSON.stringify(
    document(attempt({ billingStatus: 'pending', actualCostUsd: null }))
  )
  const file = fixture(content)
  const result = run(['--enable-executive-video-cost-audit', '--input', file, '--budget-usd', '65'])
  assert.equal(result.code, 1)
  assert.equal(result.value.assessment, 'review_required')
  assert.equal(readFileSync(file, 'utf8'), content)
})

test('CLI rejects malformed JSON without echoing private input', () => {
  const file = fixture('{"private-source":"DO NOT ECHO"')
  const result = run(['--enable-executive-video-cost-audit', '--input', file, '--budget-usd', '65'])
  assert.equal(result.code, 2)
  assert.equal(result.value.error, 'invalid JSON input')
})

test('CLI requires explicit budget and input, rejects typos, and returns success for reconciled data', () => {
  for (const args of [[], ['--budget-usd', '65'], ['--input', 'unused'], ['--budget', '65']]) {
    assert.equal(run(['--enable-executive-video-cost-audit', ...args]).code, 2)
  }
  const file = fixture(JSON.stringify(document(attempt())))
  assert.equal(
    run(['--enable-executive-video-cost-audit', '--input', file, '--budget-usd', '65']).code,
    0
  )
})
