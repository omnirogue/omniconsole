import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DecisionProviderError,
  type DecisionCallTag,
  type DecisionRequest
} from '../../shared/structured-decisions'
import { recipeCallFields, rubricCallFields } from './jev-call-rows'
import { installJevHostControl } from './jev-host-control'
import { JEV_CALLS_FILE, installJevLedger, uninstallJevLedger, type JevLedger } from './jev-ledger'
import { ledgerDirectories, readLedgerLines } from './jev-ledger.test-fixture'
import { jevDecide } from './jev-rank'
import type { JevRubricEvaluationRecord } from './jev-rubric-evaluation'
import { TypeSafeDecisionProvider } from './typesafe-provider'

const SENTINEL = 'PRIVATE-TEXT-SENTINEL'
const tag: DecisionCallTag = { caller: 'session-owner', transport: 'direct', deadlineMs: 8000 }
const request: DecisionRequest = {
  capability: 'sessions.find-owner',
  model: 'jev-1.13.0',
  state: { task: `${SENTINEL} new task`, session: `${SENTINEL} session goal` },
  questions: {
    duplicate: { type: 'noul', instructions: `Same deliverable? ${SENTINEL}` },
    fit: {
      type: 'score',
      instructions: `How well does it fit? ${SENTINEL}`,
      criteria: [`low ${SENTINEL}`, `high ${SENTINEL}`]
    }
  }
}
const wire = {
  model: 'jev-1.13.0',
  answers: {
    duplicate: { type: 'noul', noul: 0.12 },
    fit: {
      type: 'score',
      score: 0.75,
      confidence: 0.5,
      probabilities: { '0': 0.25, '1': 0.75 },
      legend: { '0': `low ${SENTINEL}`, '1': `high ${SENTINEL}` }
    }
  },
  usage: { input_tokens: 61, output_tokens: 7 }
}

const directories = ledgerDirectories()
let ledger: JevLedger
const rows = async () => {
  await ledger.exclusive(async () => undefined)
  return readLedgerLines(join(ledger.directory, JEV_CALLS_FILE))
}
const provider = (fetcher: typeof fetch, key = 'fake-test-key') =>
  new TypeSafeDecisionProvider({ fetch: fetcher, resolveApiKey: async () => key })

beforeEach(async () => {
  ledger = installJevLedger(await directories.create(), { host: 'test-host', runtimeId: 'rt-1' })
})
afterEach(async () => {
  await ledger.exclusive(async () => undefined).catch(() => undefined)
  uninstallJevLedger(ledger)
  vi.unstubAllEnvs()
  await directories.cleanup()
})

describe('in-app JEV call rows', () => {
  it('writes one hash-only evaluated row with full probabilities and no vendor confidence', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(wire)))
    const signal = new AbortController().signal

    await provider(fetcher).evaluate(request, { signal, call: tag })

    const [row, ...rest] = await rows()
    expect(rest).toEqual([])
    expect(row).toMatchObject({
      schema: 'jev-call/1',
      host: 'test-host',
      runtime_id: 'rt-1',
      caller: 'session-owner',
      transport: 'direct',
      deadline_ms: 8000,
      model: 'jev-1.13.0',
      ref: 'sessions.find-owner',
      question_ids: ['duplicate', 'fit'],
      status: null,
      provider_status: 'evaluated',
      kind: null,
      reason: null,
      answers: {
        duplicate: { type: 'noul', noul: 0.12 },
        fit: { type: 'score', score: 0.75, probabilities: { '0': 0.25, '1': 0.75 } }
      },
      usage: { input_tokens: 61, output_tokens: 7 },
      calls: 1
    })
    expect(row?.record_key).toBe(`jev-call:${String(row?.request_id)}`)
    expect(row?.ref_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row?.input_hash).toMatch(/^[0-9a-f]{64}$/)
    const file = await readFile(join(ledger.directory, JEV_CALLS_FILE), 'utf8')
    expect(file).not.toContain(SENTINEL)
    expect(file).not.toContain('confidence')
    expect(file).not.toContain('legend')
  })

  it('marks a host-off refusal not_called and a failure after sending unavailable', async () => {
    const userData = await directories.create()
    const control = installJevHostControl(userData)
    try {
      await mkdir(userData, { recursive: true })
      await control.setEnabled(false)
      const fetcher = vi.fn<typeof fetch>()
      const signal = new AbortController().signal
      await expect(provider(fetcher).evaluate(request, { signal, call: tag })).rejects.toThrow(
        'disabled'
      )
      await control.setEnabled(true)
      fetcher.mockRejectedValue(new TypeError('socket hang up'))
      await expect(provider(fetcher).evaluate(request, { signal, call: tag })).rejects.toThrow(
        'network'
      )
      await expect(provider(fetcher, '').evaluate(request, { signal, call: tag })).rejects.toThrow(
        'no_api_key'
      )
    } finally {
      control.dispose()
    }
    expect(
      (await rows()).map(({ provider_status, reason, calls, model }) => [
        provider_status,
        reason,
        calls,
        model
      ])
    ).toEqual([
      ['not_called', 'disabled', 0, null],
      ['unavailable', 'network', 1, null],
      ['not_called', 'no_api_key', 0, null]
    ])
  })

  it('names a deadline abort timeout in the row while the caller still sees cancelled', async () => {
    const hang = () =>
      vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true
            })
          })
      )
    const [deadlineFetch, cancelFetch] = [hang(), hang()]
    const deadline = new AbortController()
    const cancel = new AbortController()
    const timedOut = provider(deadlineFetch).evaluate(request, {
      signal: deadline.signal,
      call: tag
    })
    const cancelled = provider(cancelFetch).evaluate(request, { signal: cancel.signal, call: tag })
    await vi.waitFor(() => {
      expect(deadlineFetch).toHaveBeenCalled()
      expect(cancelFetch).toHaveBeenCalled()
    })
    deadline.abort(new DecisionProviderError('timeout'))
    cancel.abort()
    await expect(timedOut).rejects.toThrow('cancelled')
    await expect(cancelled).rejects.toThrow('cancelled')
    expect(
      (await rows())
        .map(({ provider_status, reason }) => `${String(provider_status)}:${String(reason)}`)
        .toSorted()
    ).toEqual(['unavailable:cancelled', 'unavailable:timeout'])
  })

  it('logs the direct path deadline as timeout; jevDecide still reports cancelled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fetcher = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
    )
    vi.stubGlobal('fetch', fetcher)
    try {
      const pending = jevDecide(request, {
        caller: 'session-prep.gate',
        credential: async () => 'k',
        environment: {}
      })
      await vi.advanceTimersByTimeAsync(8000)
      await expect(pending).resolves.toEqual({ failed: 'JEV answered cancelled' })
      expect(fetcher).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
    expect(
      (await rows()).map(({ caller, provider_status, reason }) => [caller, provider_status, reason])
    ).toEqual([['session-prep.gate', 'unavailable', 'timeout']])
  })

  it('writes nothing for an untagged provider call (the advisory path records its own row)', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(wire)))
    await provider(fetcher).evaluate(request, { signal: new AbortController().signal })
    expect(await rows()).toEqual([])
  })

  it('records direct-path refusals and tags each request with its caller', async () => {
    const off = await jevDecide(request, {
      caller: 'session-owner',
      environment: { JEV_DECISIONS_DISABLED: '1' }
    })
    expect(off).toEqual({ failed: 'JEV is turned off on this computer' })
    const evaluate = vi.fn().mockResolvedValue({
      ...wire,
      provider: 'typesafe',
      usage: { inputTokens: 1, outputTokens: 1 }
    })
    await jevDecide(request, { credential: async () => 'k', environment: {}, evaluate })
    await jevDecide(request, {
      caller: 'workflow.rank',
      credential: async () => 'k',
      environment: {},
      evaluate
    })
    expect(evaluate.mock.calls.map(([, options]) => options.call)).toEqual([
      { caller: 'sessions.find-owner', transport: 'direct', deadlineMs: 8000 },
      { caller: 'workflow.rank', transport: 'direct', deadlineMs: 8000 }
    ])
    expect(await rows()).toEqual([
      expect.objectContaining({
        caller: 'session-owner',
        provider_status: 'not_called',
        reason: 'disabled',
        question_ids: ['duplicate', 'fit'],
        calls: 0
      })
    ])
  })

  it('never fails or delays the JEV call when the ledger cannot be written', async () => {
    await mkdir(dirname(dirname(ledger.directory)), { recursive: true })
    await writeFile(dirname(ledger.directory), 'not a directory')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(wire)))
    const result = await provider(fetcher).evaluate(request, {
      signal: new AbortController().signal,
      call: tag
    })
    expect(result.answers.duplicate).toEqual({ type: 'noul', noul: 0.12 })
    await ledger.exclusive(async () => undefined)
    expect(ledger.writeFailures).toBe(1)
  })
})

describe('record-backed call rows', () => {
  it('keeps the rubric record status and counts a refusal before sending as not_called', () => {
    const record = {
      request_id: '00000000-0000-4000-8000-0000000000aa',
      observed_at: '2026-10-03T12:00:00.000Z',
      model: 'jev-1.13.0',
      rubric: { value: 'library:customer-reply', builtIn: true },
      rubric_hash: 'c'.repeat(64),
      input_hash: 'd'.repeat(64),
      criteria: [{ id: 'c1', label: 'Answers directly' }],
      status: 'unknown',
      provider_status: 'unavailable',
      kind: 'unreachable',
      reason: 'no_api_key',
      elapsed_ms: 3.21,
      calls: 0,
      answers: {}
    } as unknown as JevRubricEvaluationRecord
    expect(rubricCallFields(record)).toMatchObject({
      record_key: 'jev-rubric:00000000-0000-4000-8000-0000000000aa',
      caller: 'jev.rubrics.evaluate',
      transport: 'advisory',
      deadline_ms: 5000,
      model: null,
      ref: 'library:customer-reply',
      question_ids: ['availability', 'quality', 'c1'],
      status: 'unknown',
      provider_status: 'not_called',
      kind: 'unreachable',
      reason: 'no_api_key',
      usage: null,
      elapsed_ms: 3.2
    })
  })

  it('keeps only a hash of a saved rubric name, never the name', () => {
    const name = 'Refund for Jane Doe acct 5551234567'
    const record = {
      request_id: '00000000-0000-4000-8000-0000000000cc',
      observed_at: '2026-10-03T12:00:00.000Z',
      model: 'jev-1.13.0',
      rubric: {
        value: `saved:${name}`,
        kind: 'other',
        builtIn: false,
        rubric: { id: 'custom', name, instructions: 'Answer the refund question.' }
      },
      rubric_hash: 'c'.repeat(64),
      input_hash: 'd'.repeat(64),
      criteria: [],
      status: 'verdict',
      provider_status: 'evaluated',
      elapsed_ms: 410,
      calls: 1,
      answers: {}
    } as unknown as JevRubricEvaluationRecord
    const fields = rubricCallFields(record)
    expect(fields.ref).toBe(`saved:${createHash('sha256').update(name).digest('hex')}`)
    expect(fields.model).toBe('jev-1.13.0')
    const text = JSON.stringify(fields)
    for (const part of ['Refund', 'Jane', 'Doe', '5551234567']) {
      expect(text).not.toContain(part)
    }
  })

  it('builds request rows from the result, never from recipe state', () => {
    const fields = recipeCallFields(
      {
        recordKey: 'jev-request:00000000-0000-4000-8000-0000000000bb',
        requestId: '00000000-0000-4000-8000-0000000000bb',
        observedAt: '2026-10-03T12:00:00.000Z',
        caller: 'jev.request',
        status: 'success',
        recipeRef: 'support_triage@1'
      },
      {
        status: 'success',
        disposition: 'advisory',
        model: 'jev-1.13.0',
        elapsedMs: 300,
        inputHash: 'e'.repeat(64),
        answers: { sensitive: { type: 'noul', noul: 0.01 } },
        usage: { inputTokens: 80, outputTokens: 6 }
      },
      { calls: 1, providerStatus: 'evaluated', questionIds: ['route', 'sensitive'], refHash: null }
    )
    expect(fields).toMatchObject({
      caller: 'jev.request',
      ref: 'support_triage@1',
      status: 'success',
      provider_status: 'evaluated',
      input_hash: 'e'.repeat(64),
      answers: { sensitive: { type: 'noul', noul: 0.01 } },
      usage: { input_tokens: 80, output_tokens: 6 }
    })
    expect(
      recipeCallFields(
        {
          recordKey: 'jev-request:00000000-0000-4000-8000-0000000000dd',
          requestId: '00000000-0000-4000-8000-0000000000dd',
          observedAt: '2026-10-03T12:00:00.000Z',
          caller: 'jev.request',
          status: 'unavailable',
          recipeRef: 'support_triage@1'
        },
        {
          status: 'unavailable',
          disposition: 'review',
          reason: 'disabled',
          elapsedMs: 1,
          inputHash: 'e'.repeat(64),
          answers: {}
        },
        { calls: 0, providerStatus: 'unavailable', questionIds: [], refHash: null }
      )
    ).toMatchObject({ model: null, provider_status: 'not_called', reason: 'disabled', calls: 0 })
  })
})
