import type { ProcessResult } from '../../../shared/child-process/run-process'
import type { EvolveRunRecord } from '../../../shared/evolve-workflow'
import { workflowFleetFailure } from '../workflow-script/workflow-fleet-remote-shell'
import { upperFirst, type EvolvePoll } from './evolve-host-commands'

const MAX_EVENTS = 200

export function pushEvolveEvent(record: EvolveRunRecord, text: string, at: string): void {
  record.events.push({ at, text })
  if (record.events.length > MAX_EVENTS) {
    record.events.splice(0, record.events.length - MAX_EVENTS)
  }
  record.updatedAt = at
}

export function settleEvolveRun(
  record: EvolveRunRecord,
  state: 'done' | 'failed' | 'stopped',
  at: string,
  error?: string
): void {
  record.state = state
  if (error) {
    record.error = upperFirst(error)
  }
  pushEvolveEvent(record, record.error ?? `The run ${state === 'done' ? 'finished' : state}.`, at)
}

/** Why a submit failed, by name; a checkout older than the preset is told apart. */
export function evolveSubmitFailure(
  record: Pick<EvolveRunRecord, 'host' | 'checkout' | 'submittedBy'>,
  result: ProcessResult | undefined
): string {
  if (result?.stderr.includes('unrecognized arguments')) {
    return `The jev-lab checkout at ${record.checkout} on ${record.host} is older than the Evolve preset (its submit has no --json); update it (docs/evolve-hosts.md in jev-lab).`
  }
  if (result?.timedOut) {
    return `${record.host} did not finish submitting the spec in time; a run may be queued in the ledger for submitted-by ${record.submittedBy}.`
  }
  return workflowFleetFailure(record.host, 'submit the spec', result)
}

const STATUS_PROBLEM: Record<NonNullable<EvolvePoll['statusProblem']>, string> = {
  checkout: 'the jev-lab checkout is gone from the host',
  'not-found': 'the ledger has no such run',
  unreadable: 'the ledger status could not be read'
}

/**
 * One reading of the host applied to the record. A settled ledger run settles the record; a
 * worker the host reports exited while its ledger run never settled fails it (positive evidence
 * from the owning host); no answer is `unverifiable` and never ends the run.
 */
export function applyEvolvePoll(
  record: EvolveRunRecord,
  poll: EvolvePoll | undefined,
  lostDetail: string,
  at: string
): 'settled' | 'live' | 'lost' {
  if (!poll) {
    record.contact = { verdict: 'unverifiable', at, detail: lostDetail }
    record.updatedAt = at
    return 'lost'
  }
  if (poll.status) {
    record.ledger = poll.status
    record.ledgerReadAt = at
  }
  const ledgerStatus = poll.status?.status
  if (ledgerStatus === 'done' || ledgerStatus === 'failed') {
    record.contact = { verdict: poll.worker, at }
    if (ledgerStatus === 'done') {
      settleEvolveRun(record, 'done', at)
    } else if (record.stopRequestedAt) {
      settleEvolveRun(
        record,
        'stopped',
        at,
        'Stopped on request; the ledger recorded the run failed.'
      )
    } else {
      settleEvolveRun(
        record,
        'failed',
        at,
        `The ledger run failed (${poll.status?.failure_class ?? 'no failure class recorded'}).`
      )
    }
    return 'settled'
  }
  const problem = poll.statusProblem ? STATUS_PROBLEM[poll.statusProblem] : undefined
  if (poll.worker === 'exited') {
    record.contact = { verdict: 'exited', at, ...(problem ? { detail: problem } : {}) }
    const last = poll.log.at(-1)
    settleEvolveRun(
      record,
      record.stopRequestedAt ? 'stopped' : 'failed',
      at,
      `The worker on ${record.host} exited without settling ledger run ${record.ledgerRunId} (${ledgerStatus ? `the ledger still says ${ledgerStatus}` : (problem ?? 'unknown')}); an operator settles it before submitting again.${last ? ` Last log line: ${last}` : ''}`
    )
    return 'settled'
  }
  markEvolveContactLive(record, at, problem)
  return 'live'
}

/** The host answered: an unverifiable run reads running again, so Check again resumes following. */
export function markEvolveContactLive(record: EvolveRunRecord, at: string, detail?: string): void {
  const back = record.contact?.verdict !== 'live' && record.state === 'unverifiable'
  record.contact = { verdict: 'live', at, ...(detail ? { detail } : {}) }
  if (record.state === 'unverifiable') {
    record.state = 'running'
  }
  if (back) {
    pushEvolveEvent(record, `Contact with ${record.host} is back; following again.`, at)
  }
  record.updatedAt = at
}
