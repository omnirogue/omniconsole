import {
  waitAskRequest,
  waitAskResponse,
  waitFactsResponse,
  waitPeopleResponse,
  type WaitAskResponse,
  type WaitFactsResponse
} from '../../shared/console-waits-contract'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import type { WaitFactsAnswer, WaitFactsQuery } from '../runtime/session-outcome-event-evidence'
import { requestConsoleWorkflow as request, validated } from './console-workflow-transport'

/** A 404 without omnios's own code is a missing route; person_not_on_roster is also a 404. */
function routeMissing(error: { status?: number; code: string }): boolean {
  return error.status === 404 && error.code === 'capability_unavailable'
}

/** The facts query in the one order the route allowlist accepts. */
export function waitFactsPath(query: WaitFactsQuery): string {
  const params = new URLSearchParams()
  params.set('source', query.source)
  params.set('person_id', query.personId)
  params.set('ref', query.ref)
  params.set('since', query.since)
  params.set('match', query.match)
  return `/api/waits/facts?${params.toString()}`
}

export const consoleWaitsClient = {
  people: () => request('/api/waits/people', 'GET', waitPeopleResponse),
  facts: (query: WaitFactsQuery) => request(waitFactsPath(query), 'GET', waitFactsResponse),
  ask: (args: unknown) =>
    validated(args, waitAskRequest, (body) =>
      request('/api/waits/ask', 'POST', waitAskResponse, body, 30_000)
    )
}

/**
 * The engine's facts reader: a refusal or a transport failure is a reading of "nobody can check
 * this now", never an exception inside the host tick.
 */
export async function readConsoleWaitFacts(query: WaitFactsQuery): Promise<WaitFactsAnswer> {
  const result: ConsoleWorkflowResult<WaitFactsResponse> = await consoleWaitsClient.facts(query)
  if (!result.ok) {
    const status = result.error.status
    return {
      status: 'unavailable',
      reason: routeMissing(result.error)
        ? 'omnios does not serve wait facts yet.'
        : status === 401 || status === 403
          ? 'Sign in to omnios so this wait can be checked.'
          : `omnios could not check this (${result.error.message}).`
    }
  }
  return result.data
}

/** Post an ask through omnios; a refusal is the refusal's own words, never a silent success. */
export async function askConsoleWait(body: unknown): Promise<WaitAskResponse> {
  const result = await consoleWaitsClient.ask(body)
  if (!result.ok) {
    throw new Error(
      routeMissing(result.error)
        ? 'omnios does not accept wait asks yet.'
        : `omnios refused the ask: ${result.error.message}`
    )
  }
  return result.data
}
