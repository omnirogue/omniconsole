/**
 * The named refusals of `omni session launch` (docs/reference/agent-launch.md, R1–R16). Every
 * refusal carries `{ operationId?, outcome, nextSteps }`; a pre-send refusal says "Nothing was
 * sent." and an unknown outcome never claims that nothing launched.
 */

import {
  AGENT_SESSION_EFFORT_ONLY_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY
} from '../shared/protocol-version'
import { resolveOrchestrationCliExecutable } from './runtime/orchestration-recovery-command'
import { RuntimeClientError } from './runtime/types'
import {
  PAIRING_CODE_ROUTE_ID,
  type AgentLaunchRecord,
  type AgentLaunchRoute
} from './session-launch-record'
import { quoteCliCommandArgument } from './shell-command-quote'

export type LaunchRefusalData = {
  operationId?: string
  outcome: 'not-sent' | 'not-started' | 'unverifiable'
  nextSteps: string[]
  retryCommand?: string[]
  inspectCommand?: string[]
  [detail: string]: unknown
}

export function launchRefusal(
  code: string,
  message: string,
  data: LaunchRefusalData
): RuntimeClientError {
  return new RuntimeClientError(code, message, data)
}

/** The flag that targets the same paired computer again, or nothing for this computer. */
export function launchEnvironmentArgs(route: AgentLaunchRoute): string[] {
  if (route.kind !== 'environment') {
    return []
  }
  // Why: a pairing-code route has no stored name to select; the caller supplies the code again.
  return route.environmentId === PAIRING_CODE_ROUTE_ID
    ? ['--pairing-code', '<pairing code>']
    : ['--environment', route.name]
}

export function launchEnvironmentFlagText(route: AgentLaunchRoute): string {
  const [flag, value] = launchEnvironmentArgs(route)
  return flag && value ? ` ${flag} ${quoteCliCommandArgument(value)}` : ''
}

export function launchInspectCommand(route: AgentLaunchRoute): string[] {
  return [
    resolveOrchestrationCliExecutable(),
    'session',
    'list',
    '--json',
    ...launchEnvironmentArgs(route)
  ]
}

export function providerRefusal(): RuntimeClientError {
  return launchRefusal(
    'invalid_argument',
    'omni session launch starts claude or codex; capacity readings exist only for those two.',
    { outcome: 'not-sent', nextSteps: ['Pass --provider claude or --provider codex.'] }
  )
}

export function autoHostRefusal(): RuntimeClientError {
  return launchRefusal(
    'invalid_argument',
    '--host auto arrives with automatic placement, which needs --project <name|id>: OmniConsole then picks the computer and account and creates a fresh worktree there. Without a project, omit --host to launch where the workspace is, or name a computer from omni host list.',
    {
      outcome: 'not-sent',
      nextSteps: [
        'Add --project <name|id> (omni project list --json).',
        'Run `omni host list` to see the computers you can name.'
      ]
    }
  )
}

export function incompatibleRuntimeRefusal(host: {
  name: string
  local: boolean
  appVersion: string | null
}): RuntimeClientError {
  const version = host.appVersion ?? 'an unknown version'
  const message = host.local
    ? `This computer's running OmniConsole (${version}) cannot verify account capacity for launches yet. Restart OmniConsole to finish its update. Nothing was sent.`
    : `${host.name} runs OmniConsole ${version}, which cannot verify account capacity for launches (it does not advertise ${AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY}: an older version, or a runtime without account services). Nothing was sent. Update or restart OmniConsole on ${host.name}, or launch on another computer from omni host list.`
  return launchRefusal('incompatible_runtime', message, {
    outcome: 'not-sent',
    capability: AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY,
    nextSteps: host.local
      ? ['Restart OmniConsole on this computer, then run the same command again.']
      : [
          `Update or restart OmniConsole on ${host.name}.`,
          'Run `omni host list` for another computer.'
        ]
  })
}

export function effortOnlyRefusal(hostName: string): RuntimeClientError {
  return launchRefusal(
    'incompatible_runtime',
    `${hostName} needs ${AGENT_SESSION_EFFORT_ONLY_LAUNCH_RUNTIME_CAPABILITY} to take --effort without --model. Add --model, or omit --effort. Nothing was sent.`,
    {
      outcome: 'not-sent',
      capability: AGENT_SESSION_EFFORT_ONLY_LAUNCH_RUNTIME_CAPABILITY,
      nextSteps: []
    }
  )
}

export function effortRefusal(args: {
  effort: string
  provider: string
  model: string
  choices: string[]
}): RuntimeClientError {
  return launchRefusal(
    'invalid_argument',
    `--effort ${args.effort} is not a ${args.provider} effort for ${args.model}; choose ${args.choices.join(', ')}, or omit --effort for the host default.`,
    { outcome: 'not-sent', choices: args.choices, nextSteps: [] }
  )
}

export function hostUnreachableRefusal(
  hostName: string,
  seconds: number,
  cause: unknown
): RuntimeClientError {
  const causeCode = (cause as { code?: unknown } | null)?.code
  return launchRefusal(
    'launch_host_unverifiable',
    `Cannot reach ${hostName} within ${seconds} s, so its capacity is unverifiable. Nothing was sent.`,
    {
      outcome: 'not-sent',
      cause: {
        ...(typeof causeCode === 'string' ? { code: causeCode } : {}),
        message: cause instanceof Error ? cause.message : String(cause)
      },
      nextSteps: [
        `Check that OmniConsole is running on ${hostName}, then run the same command again.`
      ]
    }
  )
}

export function hostMismatchRefusal(args: {
  selector: string
  workspaceHost: string
  requestedHost: string
  /** Set when --host itself chose this paired computer: omitting it would aim at this one. */
  pairedName?: string
}): RuntimeClientError {
  const fix = args.pairedName
    ? `Pass --environment ${quoteCliCommandArgument(args.pairedName)} instead of --host`
    : 'Omit --host'
  return launchRefusal(
    'agent_session_host_mismatch',
    `The workspace ${args.selector} runs on ${args.workspaceHost}, not on ${args.requestedHost}. ${fix} to launch where it lives. Nothing was sent.`,
    {
      outcome: 'not-sent',
      nextSteps: [`${fix}, or pass a --worktree that lives on that computer.`]
    }
  )
}

export function composedPromptTooLargeRefusal(bytes: number, maxBytes: number): RuntimeClientError {
  return launchRefusal(
    'invalid_argument',
    `With the --folder project context, the launch prompt is ${Math.ceil(bytes / 1024)} KiB; a host accepts at most ${maxBytes / 1024} KiB. Shorten the brief or the project context, or omit --folder. Nothing was sent.`,
    { outcome: 'not-sent', nextSteps: ['Shorten the brief, or omit --folder.'] }
  )
}

/** Re-running a `--again` command verbatim mints yet another operation, so its retry drops it. */
export function launchRetryPhrase(again: Map<string, string | boolean> | boolean): string {
  const deliberate = typeof again === 'boolean' ? again : again.get('again') === true
  return deliberate ? 'this command again without --again' : 'this same command again'
}

/** A superseded operation whose replacement cannot be followed: refuse rather than mint again. */
export function replacedLaunchRefusal(
  record: AgentLaunchRecord,
  reason: 'replaced' | 'lost',
  options: { retry?: string; code?: string } = {}
): RuntimeClientError {
  const list = `omni session list --json${launchEnvironmentFlagText(record.route)}`
  const next = record.supersededBy ?? 'another operation'
  const retry = options.retry ?? 'this same command again'
  return reason === 'replaced'
    ? launchRefusal(
        options.code ?? 'agent_session_runtime_changed',
        `Operation ${record.operationId} started nothing on ${record.hostLabel}, and another identical run has already replaced it with operation ${next}. Nothing new launched. Run ${retry}; it continues operation ${next}.`,
        {
          operationId: record.operationId,
          outcome: 'not-started',
          nextSteps: [`Run ${retry}.`]
        }
      )
    : launchRefusal(
        'launch_outcome_unknown',
        `Operation ${record.operationId} was replaced by operation ${next}, whose launch record is gone from this computer, so whether ${next} started is unverifiable. Check ${list}; if nothing is running, add --again (and drop --operation-id). Nothing new launched.`,
        {
          operationId: record.operationId,
          outcome: 'unverifiable',
          nextSteps: [`Check ${list}.`]
        }
      )
}

export function restartedWhilePlanningRefusal(hostName: string): RuntimeClientError {
  return launchRefusal(
    'launch_host_unverifiable',
    `OmniConsole on ${hostName} restarted while this launch was being planned. Nothing was sent; run the command again.`,
    { outcome: 'not-sent', nextSteps: ['Run the same command again.'] }
  )
}

export function staleControllerRuntimeRefusal(args: {
  hostName: string
  given: string
  running: string
}): RuntimeClientError {
  return launchRefusal(
    'agent_session_runtime_changed',
    `--controller-runtime-id ${args.given} does not match OmniConsole on ${args.hostName} (running ${args.running}); it restarted since that id was read. Omit --controller-runtime-id. Nothing was sent.`,
    { outcome: 'not-sent', expectedRuntimeId: args.given, runtimeId: args.running, nextSteps: [] }
  )
}

/** R13: the cwd belongs to this computer, so it cannot name a workspace on a paired one. */
export function remoteCwdRefusal(
  shortcutMessage: string,
  route: AgentLaunchRoute
): RuntimeClientError {
  const list = `omni worktree list${launchEnvironmentFlagText(route)} --json`
  return launchRefusal('invalid_argument', `${shortcutMessage} List them: ${list}.`, {
    outcome: 'not-sent',
    nextSteps: [`Run \`${list}\` and pass --worktree id:<worktree id>.`]
  })
}

export function workspaceNotFoundRefusal(cwd: string): RuntimeClientError {
  return launchRefusal(
    'selector_not_found',
    `No OmniConsole workspace contains ${cwd} on this computer. Pass --worktree id:<worktree id> (omni worktree list --json) or path:<workspace root>. Nothing was sent.`,
    {
      outcome: 'not-sent',
      nextSteps: ['Run `omni worktree list --json` to find the workspace id.']
    }
  )
}
