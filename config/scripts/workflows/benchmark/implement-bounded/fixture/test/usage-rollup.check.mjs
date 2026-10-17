import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rollupUsage } from '../src/usage-rollup.mjs'

test('sums attempts that all reported usage', () => {
  const rollup = rollupUsage([
    {
      outcome: 'failed',
      startedAtMs: 1000,
      endedAtMs: 3000,
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.01
    },
    {
      outcome: 'succeeded',
      startedAtMs: 4000,
      endedAtMs: 9000,
      retryOf: 'a1',
      inputTokens: 30,
      outputTokens: 5,
      costUsd: 0.02
    }
  ])
  assert.equal(rollup.attempts, 2)
  assert.equal(rollup.succeeded, 1)
  assert.equal(rollup.failed, 1)
  assert.equal(rollup.retries, 1)
  assert.equal(rollup.wallClockMs, 8000)
  assert.equal(rollup.activeMs, 7000)
  assert.deepEqual(rollup.tokens, { input: 40, output: 7 })
  assert.equal(rollup.costUsd, 0.03)
})

test('keeps unreported usage unknown', () => {
  const rollup = rollupUsage([
    { outcome: 'succeeded', startedAtMs: 0, endedAtMs: 10, inputTokens: 10, outputTokens: 2 },
    { outcome: 'succeeded', startedAtMs: 10, endedAtMs: 20 }
  ])
  assert.equal(rollup.tokens, 'unknown')
  assert.equal(rollup.costUsd, 'unknown')
})
