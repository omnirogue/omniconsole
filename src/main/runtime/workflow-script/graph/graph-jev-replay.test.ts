import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { DecisionRequest, DecisionResult } from '../../../../shared/structured-decisions'
import { createGraphJevJudge } from './graph-jev'
import { createGraphJevScreener } from './graph-jev-screen'
import { GraphJevStore, type GraphJevRecord } from './graph-jev-store'
import type { GraphCall, GraphOutcome } from './graph-plan-types'

/**
 * Recorded by the code before JEV certainty was kept (the fixture's `parentCommit`), with its
 * requests and answers. The current code must send exactly those requests, keep the same digest
 * and markdown, and replay the parent's record as stored.
 */
type Scenario = {
  name: string
  call: GraphCall
  exchanges: { request: DecisionRequest; result: DecisionResult }[]
  outcome: { value: Record<string, unknown> }
  record: GraphJevRecord
}
const fixture = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'jev-replay-parent.json'), 'utf8')
) as { parentCommit: string; scenarios: Scenario[] }

const NEW_FIELDS: Record<string, string[]> = {
  'ballot-rubric': ['judgment'],
  'ballot-pairwise': ['judgment'],
  screen: ['certainty', 'usage', 'calls']
}

let dir = ''
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = ''
  }
})

const run = (scenario: Scenario, store: GraphJevStore, cacheOnly = false) => {
  const sent: DecisionRequest[] = []
  const evaluate = async (request: DecisionRequest) => {
    sent.push(request)
    const known = scenario.exchanges.find((exchange) =>
      isDeepStrictEqual(exchange.request, request)
    )
    if (!known) {
      throw new Error('sent a JEV request the parent code never sent')
    }
    return known.result
  }
  const options = {
    store,
    evaluate,
    credential: async () => 'k'.repeat(24),
    environment: {},
    cacheOnly
  }
  const answer: Promise<GraphOutcome> = scenario.call.screen
    ? createGraphJevScreener(options)(scenario.call)
    : createGraphJevJudge(options)(scenario.call)
  return { answer, sent }
}

const sorted = (requests: readonly DecisionRequest[]) =>
  requests.map((request) => JSON.stringify(request)).sort()

describe(`JEV screens and ballots against the parent's records (${fixture.parentCommit.slice(0, 9)})`, () => {
  it.each(fixture.scenarios.map((scenario) => [scenario.name, scenario] as const))(
    '%s: same requests, digest, call id and markdown; old keys unchanged',
    async (name, scenario) => {
      dir = mkdtempSync(join(tmpdir(), 'jev-replay-'))
      const store = new GraphJevStore(join(dir, 'jev-ballots.json'))
      const { answer, sent } = run(scenario, store)
      const outcome = (await answer) as { value: Record<string, unknown> }
      expect(sorted(sent)).toEqual(sorted(scenario.exchanges.map((exchange) => exchange.request)))
      expect(Object.keys(store.all())).toEqual([scenario.call.id])
      expect(store.read(scenario.call.id)!.digest).toBe(scenario.record.digest)
      expect(outcome.value.markdown).toBe(scenario.outcome.value.markdown)
      const { value } = outcome
      // The one addition inside an old key: each screen criterion may carry its certainty.
      const old = Object.fromEntries(
        Object.keys(scenario.outcome.value).map((key) => [
          key,
          key === 'criteria'
            ? (value.criteria as { certainty?: unknown }[]).map(
                ({ certainty: _c, ...rest }) => rest
              )
            : value[key]
        ])
      )
      expect(old).toEqual(scenario.outcome.value)
      expect(
        Object.keys(value)
          .filter((key) => !(key in scenario.outcome.value))
          .sort()
      ).toEqual(NEW_FIELDS[name]!.sort())
    }
  )

  it.each(fixture.scenarios.map((scenario) => [scenario.name, scenario] as const))(
    '%s: the parent’s record replays exactly as stored, without asking JEV',
    async (_name, scenario) => {
      dir = mkdtempSync(join(tmpdir(), 'jev-replay-'))
      const store = new GraphJevStore(join(dir, 'jev-ballots.json'))
      store.write(scenario.call.id, scenario.record)
      const { answer, sent } = run(scenario, store, true)
      expect(await answer).toEqual(scenario.record.outcome)
      expect(sent).toEqual([])
    }
  )
})
