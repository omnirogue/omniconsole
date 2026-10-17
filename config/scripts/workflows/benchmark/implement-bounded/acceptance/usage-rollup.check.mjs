import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rollupUsage } from '../src/usage-rollup.mjs'

test('no attempts is a real zero, not unknown', () => {
  assert.deepEqual(rollupUsage([]), {
    attempts: 0,
    succeeded: 0,
    failed: 0,
    retries: 0,
    wallClockMs: 0,
    activeMs: 0,
    tokens: { input: 0, output: 0 },
    partialTokens: { input: 0, output: 0, reportedAttempts: 0 },
    costUsd: 0
  })
})

test('one unreported attempt makes the total unknown but keeps the known part', () => {
  const rollup = rollupUsage([
    {
      outcome: 'failed',
      startedAtMs: 100,
      endedAtMs: 400,
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.1
    },
    { outcome: 'succeeded', startedAtMs: 900, endedAtMs: 1000, retryOf: 'a1', inputTokens: 7 }
  ])
  assert.equal(rollup.tokens, 'unknown')
  assert.deepEqual(rollup.partialTokens, { input: 10, output: 2, reportedAttempts: 1 })
  assert.equal(rollup.costUsd, 'unknown')
  assert.equal(rollup.wallClockMs, 900)
  assert.equal(rollup.activeMs, 400)
  assert.equal(rollup.retries, 1)
})

test('a reported zero is a real zero', () => {
  const rollup = rollupUsage([
    {
      outcome: 'succeeded',
      startedAtMs: 0,
      endedAtMs: 5,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0
    }
  ])
  assert.deepEqual(rollup.tokens, { input: 0, output: 0 })
  assert.equal(rollup.partialTokens.reportedAttempts, 1)
  assert.equal(rollup.costUsd, 0)
})

test('non-finite and negative counts are not reports', () => {
  const rollup = rollupUsage([
    {
      outcome: 'succeeded',
      startedAtMs: 0,
      endedAtMs: 5,
      inputTokens: Number.NaN,
      outputTokens: 1
    },
    { outcome: 'succeeded', startedAtMs: 5, endedAtMs: 9, inputTokens: 3, outputTokens: -1 }
  ])
  assert.equal(rollup.tokens, 'unknown')
  assert.deepEqual(rollup.partialTokens, { input: 0, output: 0, reportedAttempts: 0 })
})

test('cost is rounded to six places', () => {
  const rollup = rollupUsage([
    {
      outcome: 'succeeded',
      startedAtMs: 0,
      endedAtMs: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.1
    },
    {
      outcome: 'succeeded',
      startedAtMs: 1,
      endedAtMs: 2,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.2
    }
  ])
  assert.equal(rollup.costUsd, 0.3)
})

test('wall clock spans attempts given out of order', () => {
  const rollup = rollupUsage([
    { outcome: 'succeeded', startedAtMs: 500, endedAtMs: 700 },
    { outcome: 'failed', startedAtMs: 100, endedAtMs: 200 }
  ])
  assert.equal(rollup.wallClockMs, 600)
  assert.equal(rollup.activeMs, 300)
})

test('throws TypeError for a non-array', () => {
  assert.throws(() => rollupUsage(null), TypeError)
  assert.throws(() => rollupUsage({}), TypeError)
})
