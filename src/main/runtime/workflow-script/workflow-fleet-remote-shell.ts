import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import { runProcess } from '../../../shared/child-process/run-process'
import { workflowFleetSshArgs } from './local-workflow-fleet-hosts'

/** Unset on the host before any CLI runs: none of them may bill an API key. */
export const WORKFLOW_FLEET_API_KEY_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY'
] as const

/** Single-quoted for a POSIX shell; any text, quotes included. */
export function workflowFleetShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** What a dispatched step sends over SSH: POSIX sh, whatever the account's login shell is. */
export function workflowFleetRemoteCommand(script: string): string {
  return `exec /bin/sh -c ${workflowFleetShellQuote(script)}`
}

/** `unset` for every API key variable, so a CLI can only use the host's own login. */
export const WORKFLOW_FLEET_UNSET_API_KEYS = `unset ${WORKFLOW_FLEET_API_KEY_ENV.join(' ')}`

export type WorkflowFleetRun = (spec: ProcessSpec) => Promise<ProcessResult>

/** Why a step on the host failed, by name, with SSH's or the host's last word. */
export function workflowFleetFailure(
  host: string,
  what: string,
  result: ProcessResult | undefined
): string {
  if (!result) {
    return `${host} could not be reached to ${what}.`
  }
  if (result.timedOut) {
    return `${host} did not finish ${what} in time.`
  }
  const line = result.stderr
    .split('\n')
    .map((entry) => entry.trim())
    .findLast(Boolean)
  return `${host} could not ${what}${line ? ` (${line.slice(0, 200)})` : ''}.`
}

/** One SSH step on a host; a spawn failure is no result, never a guess. */
export async function workflowFleetSsh(
  deps: { run?: WorkflowFleetRun },
  alias: string,
  script: string,
  timeoutMs: number,
  maxOutputBytes = 256 * 1024
): Promise<ProcessResult | undefined> {
  try {
    return await (deps.run ?? runProcess)({
      program: 'ssh',
      args: workflowFleetSshArgs(alias, workflowFleetRemoteCommand(script)),
      timeoutMs,
      maxOutputBytes
    })
  } catch {
    return undefined
  }
}
