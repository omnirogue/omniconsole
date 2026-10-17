/**
 * `omni session list|continue|ask|stop|restart|rename|conflicts|tidy|show` — one conversation managing the
 * others on this computer, when the person asks it. Each command is one `sessionManage.*` call; the
 * runtime identifies the acting session from the pane evidence this client attaches, applies the
 * checks, writes the audit line and shows the window's toast.
 */

import {
  SESSION_MANAGE_RPC,
  SESSION_MANAGE_STATES,
  type SessionConflictsResult,
  type SessionManageActionResult,
  type SessionManageAnswerResult,
  type SessionManageAskResult,
  type SessionManageListResult,
  type SessionManageState
} from '../../shared/session-manage-types'
import type { SessionShowResult } from '../../shared/session-show'
import type { CommandHandler, HandlerContext } from '../dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import {
  formatSessionAction,
  formatSessionAnswer,
  formatSessionAsk,
  formatSessionConflicts,
  formatSessionList,
  formatSessionShow
} from '../session-manage-format'
import { resolveSessionTarget } from './session-folder-target'
import { explicitTarget, refuseRemote } from './session-manage-access'
import { sessionProvenance } from './session-provenance-flags'
import { parseHost } from './session-host-flag'
import { sessionTidyHandler } from './session-tidy'
import { continueWhenIdle, whenIdleOptions } from './session-reuse'
import { titleOriginFlag } from './title-origin-flag'

type Flags = HandlerContext['flags']

const ASK_DEFAULT_TIMEOUT_MS = 5 * 60_000
const ASK_MAX_TIMEOUT_MS = 30 * 60_000
const ASK_CLIENT_GRACE_MS = 15_000
const CONFLICTS_TIMEOUT_MS = 120_000
/** `stalled` is the steward's list, not a state: filtered here, so an older host needs nothing new. */
const STALLED_FILTER = 'stalled'

function parseStates(raw: string | undefined): { states?: SessionManageState[]; stalled: boolean } {
  if (raw === undefined) {
    return { stalled: false }
  }
  const states = raw
    .split(',')
    .map((state) => state.trim())
    .filter(Boolean)
  const unknown = states.filter(
    (state) =>
      state !== STALLED_FILTER && !(SESSION_MANAGE_STATES as readonly string[]).includes(state)
  )
  if (!states.length || unknown.length) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown --state ${unknown.join(', ') || '(empty)'}. Use one or more of: ${[...SESSION_MANAGE_STATES, STALLED_FILTER].join(', ')}.`
    )
  }
  const real = states.filter((state) => state !== STALLED_FILTER) as SessionManageState[]
  return { ...(real.length ? { states: real } : {}), stalled: states.includes(STALLED_FILTER) }
}

function continueAnswer(
  flags: Flags
): { kind: 'yes' } | { kind: 'choose'; choice: number } | { kind: 'prompt'; text: string } {
  const choice = getOptionalPositiveIntegerFlag(flags, 'choose')
  const prompt = getOptionalStringFlag(flags, 'prompt')
  const yes = flags.get('yes') === true
  if ([yes, choice !== undefined, prompt !== undefined].filter(Boolean).length !== 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass exactly one of --yes, --choose <n> or --prompt "<text>".'
    )
  }
  return yes
    ? { kind: 'yes' }
    : choice !== undefined
      ? { kind: 'choose', choice }
      : { kind: 'prompt', text: prompt! }
}

async function act(
  { client, flags, json }: HandlerContext,
  method: string,
  params: Record<string, unknown>
): Promise<void> {
  const response = await client.call<SessionManageActionResult>(method, {
    ...params,
    ...sessionProvenance(flags)
  })
  printResult(response, json, formatSessionAction)
}

export const SESSION_MANAGE_HANDLERS: Record<string, CommandHandler> = {
  'session list': async ({ client, flags, json }) => {
    refuseRemote(client)
    const hostId = parseHost(getOptionalStringFlag(flags, 'host'))
    const query = getOptionalStringFlag(flags, 'query')?.trim()
    if (query !== undefined && (!query || query.length > 256)) {
      throw new RuntimeClientError('invalid_argument', '--query must contain 1–256 characters.')
    }
    const { states, stalled } = parseStates(getOptionalStringFlag(flags, 'state'))
    const folder = getOptionalStringFlag(flags, 'folder')
    const project = getOptionalStringFlag(flags, 'project')
    const response = await client.call<SessionManageListResult>(SESSION_MANAGE_RPC.list, {
      ...(hostId ? { hostId } : {}),
      ...(query ? { query } : {}),
      // Why no states with stalled: a Stalled session may be in any state.
      ...(states && !stalled ? { states } : {}),
      ...(folder ? { folder } : {}),
      ...(project ? { project } : {}),
      ...(flags.get('include-archived') === true ? { includeArchived: true } : {}),
      // Session parity (C5): this command exports the population; the other callers skip it.
      parity: true
    })
    if (stalled) {
      response.result.sessions = response.result.sessions.filter(
        (entry) => entry.stalled || states?.includes(entry.state)
      )
    }
    printResult(response, json, formatSessionList)
  },
  'session continue': async (context) => {
    refuseRemote(context.client)
    const answer = continueAnswer(context.flags)
    const whenIdle = whenIdleOptions(context.flags)
    if (whenIdle && answer.kind !== 'prompt') {
      throw new RuntimeClientError(
        'invalid_argument',
        '--when-idle holds a --prompt; --yes and --choose answer its current proposal, which cannot wait.'
      )
    }
    const target = await explicitTarget(context.client, context.flags)
    if (whenIdle && answer.kind === 'prompt') {
      await continueWhenIdle(context, target, answer.text, whenIdle)
      return
    }
    await act(context, SESSION_MANAGE_RPC.continue, { target, answer })
  },
  'session answer': async ({ client, flags, json }) => {
    refuseRemote(client)
    const expect = getRequiredStringFlag(flags, 'expect')
    const choice = getOptionalPositiveIntegerFlag(flags, 'choose')
    const text = getOptionalStringFlag(flags, 'text')
    const allow = flags.get('allow') === true
    const deny = flags.get('deny') === true
    if ([allow, deny, choice !== undefined, text !== undefined].filter(Boolean).length !== 1) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass exactly one of --allow, --deny, --choose <n> or --text "<reply>".'
      )
    }
    const resolved = await explicitTarget(client, flags)
    if (!resolved.paneKey) {
      throw new RuntimeClientError(
        'invalid_argument',
        'The terminal cannot be resolved to an exact pane; use --pane from session list.'
      )
    }
    const terminal = getOptionalStringFlag(flags, 'terminal')
    const response = await client.call<SessionManageAnswerResult>(SESSION_MANAGE_RPC.answer, {
      target: { paneKey: resolved.paneKey, ...(terminal ? { terminal } : {}) },
      expect,
      answer: allow
        ? { kind: 'allow' }
        : deny
          ? { kind: 'deny' }
          : choice !== undefined
            ? { kind: 'choose', choice }
            : { kind: 'text', text },
      ...sessionProvenance(flags)
    })
    printResult(response, json, formatSessionAnswer)
    if (response.result.delivery === 'unconfirmed') {
      process.exitCode = 1
    }
  },
  'session ask': async (context) => {
    const { client, flags, json } = context
    refuseRemote(client)
    const question = getRequiredStringFlag(flags, 'question')
    const timeoutMs = getOptionalPositiveIntegerFlag(flags, 'timeout-ms')
    if (timeoutMs !== undefined && (timeoutMs < 1_000 || timeoutMs > ASK_MAX_TIMEOUT_MS)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--timeout-ms must be between 1000 and ${ASK_MAX_TIMEOUT_MS}.`
      )
    }
    const target = await explicitTarget(client, flags)
    const expectedRef = getOptionalStringFlag(flags, 'ref')
    const response = await client.call<SessionManageAskResult>(
      SESSION_MANAGE_RPC.ask,
      {
        target,
        question,
        ...(expectedRef ? { expectedRef } : {}),
        ...(flags.get('require-keep-going-off') === true ? { requireKeepGoingOff: true } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...sessionProvenance(flags)
      },
      { timeoutMs: (timeoutMs ?? ASK_DEFAULT_TIMEOUT_MS) + ASK_CLIENT_GRACE_MS }
    )
    printResult(response, json, formatSessionAsk)
    if (!response.result.dryRun && response.result.outcome !== 'answered') {
      process.exitCode = 1
    }
  },
  'session stop': async (context) => {
    refuseRemote(context.client)
    const target = await explicitTarget(context.client, context.flags)
    await act(context, SESSION_MANAGE_RPC.stop, {
      target,
      ...(context.flags.get('force') === true ? { force: true } : {})
    })
  },
  'session restart': async (context) => {
    refuseRemote(context.client)
    const target = await explicitTarget(context.client, context.flags)
    await act(context, SESSION_MANAGE_RPC.restart, { target })
  },
  'session rename': async (context) => {
    refuseRemote(context.client)
    const title = getRequiredStringFlag(context.flags, 'title')
    const origin = titleOriginFlag(context.flags, 'origin')
    const target = await resolveSessionTarget(context.client, context.flags)
    await act(context, SESSION_MANAGE_RPC.rename, { target, title, ...(origin ? { origin } : {}) })
  },
  'session conflicts': async ({ client, json }) => {
    refuseRemote(client)
    const response = await client.call<SessionConflictsResult>(
      SESSION_MANAGE_RPC.conflicts,
      undefined,
      {
        timeoutMs: CONFLICTS_TIMEOUT_MS
      }
    )
    printResult(response, json, formatSessionConflicts)
  },
  'session tidy': sessionTidyHandler,
  'session show': async ({ client, flags, json }) => {
    const beside = flags.get('beside') === true
    const replace = flags.get('replace') === true
    if (beside && replace) {
      throw new RuntimeClientError('invalid_argument', 'Pass --beside or --replace, not both.')
    }
    // Why no refuseRemote: the host answers a remote caller itself, showing nothing on its window.
    const target = await explicitTarget(client, flags)
    const response = await client.call<SessionShowResult>(SESSION_MANAGE_RPC.show, {
      target,
      mode: replace ? 'replace' : 'beside',
      ...(flags.get('no-flash') === true ? { flash: false } : {})
    })
    printResult(response, json, formatSessionShow)
    if (!response.result.shown) {
      process.exitCode = 1
    }
  }
}
