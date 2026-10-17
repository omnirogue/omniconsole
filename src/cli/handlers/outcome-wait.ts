import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { createOrchestrationCompatibilityEnvelope } from '../runtime/orchestration-compatibility-envelope'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { SessionOutcomeEvent } from '../../shared/session-outcome-event'
import { SESSION_MANAGE_RPC, type SessionManageListResult } from '../../shared/session-manage-types'
import { parseSessionReference } from '../../shared/session-reference'
import { resolveSessionRefTarget } from './session-ref-target'

/** The source conversation these commands speak for, with its launch claim. */
function sourceCall(flags: HandlerContext['flags']) {
  const paneKey = process.env.ORCA_PANE_KEY?.trim()
  if (!paneKey) {
    throw new RuntimeClientError(
      'invalid_environment',
      'Run outcome commands inside the current OmniConsole source conversation.'
    )
  }
  const capability = flags.get('dispatch-capability')
  return {
    params: {
      paneKey,
      ...(process.env.ORCA_WORKTREE_ID ? { worktreeId: process.env.ORCA_WORKTREE_ID } : {})
    },
    options: {
      ...createOrchestrationCompatibilityEnvelope(process.env),
      ...(typeof capability === 'string' ? { orchestrationCapability: capability } : {})
    }
  }
}

function text(flags: HandlerContext['flags'], name: string): string {
  const value = flags.get(name)
  if (typeof value !== 'string' || !value.trim()) {
    throw new RuntimeClientError('invalid_argument', `Missing --${name}.`)
  }
  return value.trim()
}

/**
 * `outcome wait --on-session <pane|ref>`: check the session to wait on and print the `event` the
 * plan carries. Files nothing; the host admits the wait again at commit.
 */
const sessionWait: CommandHandler = async ({ client, flags, json }) => {
  const capabilities = await client.call<{ sessionWaits?: number }>(
    'sessionChain.outcomeCapabilities'
  )
  if (capabilities.result.sessionWaits !== 1) {
    throw new RuntimeClientError(
      'unsupported_capability',
      "This OmniConsole cannot wait on another session's result. Update it, then file the wait again."
    )
  }
  const value = text(flags, 'on-session')
  const paneKey = parseSessionReference(value)
    ? (await resolveSessionRefTarget(client, value)).paneKey
    : value
  if (paneKey === process.env.ORCA_PANE_KEY?.trim()) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${value} is this conversation; a session cannot wait on its own result.`
    )
  }
  const listed = await client.call<SessionManageListResult>(
    SESSION_MANAGE_RPC.list,
    { includeArchived: true },
    { timeoutMs: 60_000 }
  )
  const entry = listed.result.sessions.find((session) => session.paneKey === paneKey)
  if (!entry) {
    throw new RuntimeClientError(
      'not_found',
      `No session in omni session list has pane ${paneKey}. Name one with its pane key or --ref.`
    )
  }
  if (parseExecutionHostId(entry.hostId)?.kind !== 'local') {
    throw new RuntimeClientError(
      'invalid_argument',
      `“${entry.title}” does not run on this computer, so its result cannot be waited on here.`
    )
  }
  const event: SessionOutcomeEvent = { source: 'session', match: 'result', ref: paneKey }
  const label = `${entry.title} finishes`.slice(0, 200)
  printResult(
    { ...listed, result: { event, label, title: entry.title, state: entry.state } },
    json,
    () => `Put this in the wait condition: event ${JSON.stringify(event)}, label "${label}".`
  )
}

/** Merged into `OUTCOME_HANDLERS`; this module is not a handler group of its own. */
export const outcomeWaitHandlers: Record<string, CommandHandler> = {
  'outcome ask': async ({ client, flags, json }) => {
    const via = text(flags, 'via')
    if (via !== 'slack' && via !== 'email') {
      throw new RuntimeClientError('invalid_argument', '--via is slack or email.')
    }
    const { params, options } = sourceCall(flags)
    const result = await client.call<{ handle: string; asked_at: string }>(
      'sessionChain.waitAsk',
      { ...params, person: text(flags, 'person'), via, text: text(flags, 'text') },
      options
    )
    printResult(
      result,
      json,
      (asked) =>
        `Asked. Put handle ${asked.handle} in event.ref and ${asked.asked_at} in event.since.`
    )
  },
  'outcome wait': async (context) => {
    if (context.flags.has('on-session')) {
      return sessionWait(context)
    }
    const { client, flags, json } = context
    const choice = text(flags, 'choice')
    const { params, options } = sourceCall(flags)
    const condition = flags.get('condition')
    const result = await client.call(
      'sessionChain.sourceWaitChoice',
      { ...params, choice, ...(typeof condition === 'string' ? { conditionId: condition } : {}) },
      options
    )
    printResult(result, json, () => `Recorded: ${choice.replace('-', ' ')}.`)
  }
}
