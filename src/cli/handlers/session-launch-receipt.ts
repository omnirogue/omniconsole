import type { SessionPrepRoutingReceipt } from '../../shared/session-prep-types'
import type {
  AgentLaunchAccountReceipt,
  AgentLaunchEffectiveModel,
  AgentLaunchReadinessAccount
} from '../../shared/agent-launch-account'
import type { LaunchPlacement } from '../../shared/agent-launch-placement-types'
import {
  findCatalogModel,
  getAgentSessionOptionCatalog
} from '../../shared/agent-session-option-catalog'
import { launchManifestLines, type LaunchManifestReport } from '../../shared/launch-manifest'
import type { CapacityProvider } from '../../shared/provider-account-capacity'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../shared/remote-runtime-client-error-classification'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import { launchFlagsAsTyped } from '../launch-host-name'
import { RuntimeClientError } from '../runtime-client'
import { resolveOrchestrationCliExecutable } from '../runtime/orchestration-recovery-command'
import {
  recordedLaunchOutcome,
  type AgentLaunchHostReceipt,
  type AgentLaunchRecord,
  type AgentLaunchRoute,
  type AgentLaunchWorkspaceReceipt,
  type SettledLaunchSend
} from '../session-launch-record'
import {
  launchEnvironmentFlagText,
  launchInspectCommand,
  launchRefusal,
  launchRetryPhrase
} from '../session-launch-refusals'

export type LaunchReceiptResult = {
  terminal: RuntimeTerminalCreate
  disposition: 'created' | 'replayed' | 'already-launched'
  operationId: string
  host: AgentLaunchHostReceipt
  workspace: AgentLaunchWorkspaceReceipt
  /** Null when the executing OmniConsole did not report the account (legacy SSH path). */
  account: AgentLaunchAccountReceipt | null
  launch: AgentLaunchEffectiveModel | null
  routing?: SessionPrepRoutingReceipt
  record: string
  retryCommand: string[]
  warnings: string[]
  manifest: LaunchManifestReport
  project?: unknown
  /** --project: the frozen pick, its runner-up and every computer looked at. */
  placement?: LaunchPlacement
  launchedAt?: number
}

export type LaunchPlanView = {
  launched: false
  operationId: null
  host: AgentLaunchHostReceipt
  workspace: AgentLaunchWorkspaceReceipt
  account: AgentLaunchReadinessAccount | null
  launch: { model: string | null; effort: string | null; source: 'request' | 'host-default' }
  wouldRefuse: { code: string; message: string; data?: unknown } | null
  manifest: LaunchManifestReport
  project: unknown
  warnings: string[]
}

// Why: flags that start something new or only shape this output are not part of "the same command".
const NOT_REPEATED_FLAGS = new Set(['again', 'dry-run', 'help'])
const EXPLICIT_OPERATION_FLAGS = new Set(['operation-id', 'controller-runtime-id'])

/**
 * The command that retries this launch; with `again`, the one that deliberately starts another.
 * --host stays as typed, so the retry hashes to the same intent whichever route it resolves to.
 */
export function launchRetryCommand(
  flags: Map<string, string | boolean>,
  options: { again?: boolean } = {}
): string[] {
  const args = [resolveOrchestrationCliExecutable(), 'session', 'launch']
  for (const [name, value] of launchFlagsAsTyped(flags)) {
    if (NOT_REPEATED_FLAGS.has(name) || (options.again && EXPLICIT_OPERATION_FLAGS.has(name))) {
      continue
    }
    // Why: a pairing code is a credential; the caller supplies it again rather than reading it here.
    const shown = name === 'pairing-code' ? '<pairing code>' : value
    args.push(`--${name}`, ...(typeof shown === 'string' ? [shown] : []))
  }
  return options.again ? [...args, '--again'] : args
}

const BOUND_LABELS = { 'five-hour': '5-hour', weekly: 'weekly', 'fable-weekly': 'Fable weekly' }

function accountText(account: AgentLaunchAccountReceipt, preview: boolean): string {
  const bound = account.boundBy ? ` (${BOUND_LABELS[account.boundBy]})` : ''
  const age = `read ${Math.round(account.readingAgeMs / 1000)} s ${preview ? 'ago' : 'before selection'}`
  const best = account.verified === null ? '' : `; best of ${account.verified} verified`
  return `${preview ? 'would pick ' : ''}${account.label}: ${account.remainingPercent}% left${bound}, ${age}${best}`
}

function modelText(
  launch: AgentLaunchEffectiveModel | null,
  routing?: SessionPrepRoutingReceipt
): string {
  if (!launch) {
    return 'not reported by this OmniConsole'
  }
  const effort = launch.effort ? `, effort ${launch.effort}` : ''
  const source =
    routing?.status === 'selected'
      ? 'router selection; served model not attested'
      : launch.source === 'request'
        ? 'as requested'
        : launch.source === 'host-default'
          ? 'host defaults'
          : "the account's own settings"
  return `${launch.model ?? 'default model'}${effort} (${source})`
}

function hostHeading(host: AgentLaunchHostReceipt): string {
  return `${host.name} (${host.route}, OmniConsole ${host.appVersion ?? 'version unknown'})`
}

export function formatLaunchReceipt(
  result: LaunchReceiptResult,
  provider: string,
  options: { again?: boolean } = {}
): string {
  if (result.disposition === 'already-launched') {
    const at = result.launchedAt ? new Date(result.launchedAt).toISOString() : 'an earlier run'
    return [
      `Already launched at ${at} on ${result.host.name} (operation ${result.operationId}, terminal ${result.terminal.handle}); nothing new started. Add --again to start another session with the same brief.`,
      ...result.warnings
    ].join('\n')
  }
  const replayed = result.disposition === 'replayed' ? ' (replayed; nothing new started)' : ''
  return [
    `Launched ${provider} on ${hostHeading(result.host)}: ${result.terminal.handle}${replayed}`,
    `  account   ${result.account ? accountText(result.account, false) : 'chosen by the SSH host (this OmniConsole did not report it)'}`,
    `  model     ${modelText(result.launch, result.routing)}`,
    ...(result.routing ? [`  routing   ${result.routing.status}: ${result.routing.reason}`] : []),
    `  visible   in ${result.host.visibleIn}`,
    `  operation ${result.operationId}  Unsure it started? Run ${launchRetryPhrase(options.again === true)}; it never starts a second session.`,
    ...result.warnings
  ].join('\n')
}

function effortNote(provider: CapacityProvider, model: string | null): string {
  const catalog = getAgentSessionOptionCatalog(provider)
  return model && catalog && findCatalogModel(catalog, model)
    ? `--effort; valid for ${model}`
    : '--effort; not checked: no catalog entry for the model'
}

function previewAccountLines(account: AgentLaunchReadinessAccount | null): string[] {
  if (!account) {
    return ['  account   chosen by the SSH host at launch (this OmniConsole cannot preview it)']
  }
  if (!account.verified) {
    const others = account.accounts.map((candidate) => `${candidate.label}: ${candidate.reason}`)
    return [
      `  account   none verified: ${account.refusal}`,
      ...(others.length ? [`  others    ${others.join(' · ')}`] : [])
    ]
  }
  const others = account.receipt.excluded.map((entry) => `${entry.label}: ${entry.reason}`)
  return [
    `  account   ${accountText(account.receipt, true)}`,
    ...(others.length ? [`  others    ${others.join(' · ')}`] : [])
  ]
}

export function formatLaunchPlan(view: LaunchPlanView, provider: CapacityProvider): string {
  const { model, effort } = view.launch
  const modelPart = model ? `${model} (--model)` : 'host default'
  const effortPart = effort
    ? `effort ${effort} (${model ? effortNote(provider, model) : '--effort'})`
    : 'effort host default'
  return [
    `Would launch ${provider} on ${hostHeading(view.host)} in ${view.workspace.selector}${view.workspace.kind ? ` [${view.workspace.kind}]` : ''}`,
    ...previewAccountLines(view.account),
    `  model     ${modelPart}   ${effortPart}`,
    ...(view.wouldRefuse ? [`  would refuse: ${view.wouldRefuse.message}`] : []),
    '  Nothing launched. A preview is not a reservation: the launch re-checks capacity on that computer just before it starts.',
    ...launchManifestLines(view.manifest).map((line) => `  ${line}`),
    ...view.warnings
  ].join('\n')
}

/** R3, R4 and R4b: the outcome is unverifiable, so the text never says nothing launched. */
export function launchRecoveryError(
  kind: 'restarted' | 'unknown' | 'expired',
  args: {
    record: AgentLaunchRecord
    flags: Map<string, string | boolean>
    runtimeId?: string
    cause?: SettledLaunchSend
  }
): RuntimeClientError {
  const { record } = args
  const id = record.operationId
  const list = `omni session list --json${launchEnvironmentFlagText(record.route)}`
  const host = record.hostLabel
  const data = {
    operationId: id,
    outcome: 'unverifiable' as const,
    inspectCommand: launchInspectCommand(record.route),
    ...(args.cause ? { cause: { code: args.cause.code, message: args.cause.message } } : {})
  }
  if (kind === 'unknown') {
    const cause = args.cause
    // Why: a lost connection and a host that answered with an unclassified error read differently.
    const answered =
      cause && !isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(cause))
        ? `${host} answered operation ${id} with ${cause.code ?? 'an error'}: ${cause.message}; whether it started is unverifiable.`
        : `${host} did not confirm the launch within 240 s; it may have started (unverifiable).`
    const retry = launchRetryPhrase(args.flags)
    return launchRefusal(
      'launch_outcome_unknown',
      `${answered} Do not launch again with a new ID: run ${retry} (it reuses operation ${id} and never starts a second session), or check ${list}.`,
      {
        ...data,
        retryCommand: launchRetryCommand(args.flags),
        nextSteps: [`Run ${retry}.`, `Check ${list}.`]
      }
    )
  }
  const message =
    kind === 'restarted'
      ? `OmniConsole on ${host} restarted after operation ${id} was sent (runtime ${record.executingRuntimeId} is now ${args.runtimeId ?? 'unknown'}), so whether that launch started is unverifiable. Check ${list}; if nothing is running, add --again to start a new launch. Nothing new launched.`
      : `Operation ${id} is over 24 h old and an earlier attempt's outcome is unverifiable. Check ${list}; if nothing is running, add --again. Nothing new launched.`
  return launchRefusal(
    kind === 'restarted' ? 'agent_session_runtime_changed' : 'launch_outcome_unknown',
    message,
    {
      ...data,
      retryCommand: launchRetryCommand(args.flags, { again: true }),
      nextSteps: [`Check ${list}.`, 'If nothing is running, run the same command with --again.']
    }
  )
}

/** A host refusal before spawn: keep its code, text and data, and name the operation to retry. */
export function notStartedLaunchError(
  error: unknown,
  record: AgentLaunchRecord,
  flags: Map<string, string | boolean>
): RuntimeClientError {
  const original = error instanceof RuntimeClientError ? error : null
  const data =
    original?.data && typeof original.data === 'object'
      ? (original.data as Record<string, unknown>)
      : {}
  const nextSteps = Array.isArray(data.nextSteps) ? (data.nextSteps as string[]) : []
  return launchRefusal(
    original?.code ?? 'runtime_error',
    error instanceof Error ? error.message : String(error),
    {
      ...data,
      operationId: record.operationId,
      outcome: 'not-started',
      retryCommand: launchRetryCommand(flags),
      nextSteps: [
        ...nextSteps,
        `Fix the cause, then run ${launchRetryPhrase(flags)}; it reuses operation ${record.operationId}.`
      ]
    }
  )
}

function launchRouteVia(route: AgentLaunchRoute): string {
  return route.kind === 'local' ? "this computer's OmniConsole" : `OmniConsole on ${route.name}`
}

/**
 * A retry that cannot reach the recorded route (R7 on a follow) or would reach another one: the
 * record, not this run, says what may have started, so the text never claims nothing was sent
 * when an earlier send is unverifiable.
 */
export function heldLaunchRefusal(
  kind: 'unreachable' | 'rerouted',
  args: {
    record: AgentLaunchRecord
    flags: Map<string, string | boolean>
    cause?: unknown
    route?: AgentLaunchRoute
  }
): RuntimeClientError {
  const { record } = args
  const id = record.operationId
  const outcome = recordedLaunchOutcome(record)
  const list = `omni session list --json${launchEnvironmentFlagText(record.route)}`
  const via = launchRouteVia(record.route)
  const maybe = outcome === 'unverifiable' ? '; whether it started is unverifiable' : ''
  const closing =
    outcome === 'unverifiable'
      ? 'Nothing new launched.'
      : outcome === 'not-started'
        ? 'Nothing launched.'
        : 'Nothing was sent.'
  const retry = `Run ${launchRetryPhrase(args.flags)} once ${via} answers; it reuses operation ${id}.`
  const message =
    kind === 'unreachable'
      ? `Cannot reach ${via} to retry operation ${id}${maybe}. ${closing} ${retry}`
      : `Operation ${id} (${record.hostLabel}) was recorded through ${via}, but --host now resolves to ${args.route ? launchRouteVia(args.route) : 'another route'}, so this run does not resend it there${maybe}. Nothing new launched. ${retry} Or check ${list}; if nothing is running there, add --again.`
  const cause = (args.cause as { data?: { cause?: unknown } } | undefined)?.data?.cause
  return launchRefusal('launch_host_unverifiable', message, {
    operationId: id,
    outcome,
    inspectCommand: launchInspectCommand(record.route),
    retryCommand: launchRetryCommand(args.flags),
    ...(cause ? { cause } : {}),
    nextSteps: [retry, `Check ${list}.`]
  })
}
