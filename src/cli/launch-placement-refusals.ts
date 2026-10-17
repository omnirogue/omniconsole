/**
 * Refusals of `omni session launch --project` (docs/reference/agent-launch.md, R17 and the
 * placement steps). Like the PR 1 refusals each carries `{ operationId?, outcome, nextSteps }`.
 */

import { launchPlacementRefusal } from '../shared/agent-launch-placement'
import type {
  LaunchPlacement,
  LaunchPlacementCandidateSummary,
  LaunchPlacementProject,
  LaunchPlacementRoute
} from '../shared/agent-launch-placement-types'
import type { CapacityProvider } from '../shared/provider-account-capacity'
import { getOptionalStringFlag } from './flags'
import { resolveOrchestrationCliExecutable } from './runtime/orchestration-recovery-command'
import { RuntimeClientError } from './runtime/types'
import type { AgentLaunchRecord, AgentLaunchRoute } from './session-launch-record'
import {
  autoHostRefusal,
  launchEnvironmentArgs,
  launchRefusal,
  type LaunchRefusalData
} from './session-launch-refusals'
import { quoteCliCommandArgument } from './shell-command-quote'

// Why: each of these fixes the computer, or needs this computer as the controller, before
// placement has chosen one. The next step is "Omit --<flag>." unless one is given.
const PLACEMENT_CONFLICTS: [flag: string, why: string, nextStep?: string][] = [
  [
    'worktree',
    'a worktree already fixes the computer; omit --project to launch there',
    // Why: omitting --worktree would make a second, fresh default-base worktree and leave the
    // caller's own checkout unused, so the usual fix is to drop --project.
    'Omit --project to launch into that worktree (or omit --worktree for a fresh worktree from the repo default base).'
  ],
  ['environment', 'it picks the computer itself; pass --host <name> to keep it on one computer'],
  ['pairing-code', 'it picks the computer itself; pass --host <name> to keep it on one computer'],
  ['folder', '--folder needs this computer as the controller, and placement may pick another'],
  ['agent-template', '--agent-template needs this computer as the controller'],
  ['operation-id', 'it records its own operation; run the same command again to retry'],
  ['controller-runtime-id', 'it records its own operation; run the same command again to retry']
]

/** --project, --name and their conflicts, checked before any host contact. */
export function readLaunchPlacementFlags(flags: Map<string, string | boolean>): {
  project?: string
  worktreeName?: string
} {
  const project = getOptionalStringFlag(flags, 'project')?.trim()
  if (flags.has('project') && !project) {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --project')
  }
  if (!project) {
    if (getOptionalStringFlag(flags, 'host')?.trim().toLowerCase() === 'auto') {
      throw autoHostRefusal()
    }
    if (flags.has('name')) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--name names the fresh worktree that --project creates; omit it, or add --project <name|id>.'
      )
    }
    return {}
  }
  for (const [flag, why, nextStep] of PLACEMENT_CONFLICTS) {
    if (flags.has(flag)) {
      throw launchRefusal('invalid_argument', `--project cannot take --${flag}: ${why}.`, {
        outcome: 'not-sent',
        nextSteps: [nextStep ?? `Omit --${flag}.`]
      })
    }
  }
  const name = getOptionalStringFlag(flags, 'name')?.trim()
  return { project, ...(name ? { worktreeName: name } : {}) }
}

/** R17: nothing recorded or sent, and never a fallback to this computer. */
export function noComputerRefusal(args: {
  provider: CapacityProvider
  project: LaunchPlacementProject
  candidates: LaunchPlacementCandidateSummary[]
}): RuntimeClientError {
  return launchRefusal(
    'launch_no_computer',
    launchPlacementRefusal({
      provider: args.provider,
      project: args.project.identityKey,
      candidates: args.candidates
    }),
    {
      outcome: 'not-sent',
      project: args.project,
      candidates: args.candidates,
      nextSteps: [
        'Fix one computer above (each line says why it cannot take the launch), then run the same command again.'
      ]
    }
  )
}

export function placedLaunchRoute(route: LaunchPlacementRoute): AgentLaunchRoute {
  return route.kind === 'environment'
    ? { kind: 'environment', environmentId: route.environmentId, name: route.name }
    : { kind: 'local' }
}

function cliCommand(args: string[]): string {
  return args.map(quoteCliCommandArgument).join(' ')
}

function placementWorktreeListArgs(route: LaunchPlacementRoute): string[] {
  return [
    resolveOrchestrationCliExecutable(),
    'worktree',
    'list',
    '--json',
    ...launchEnvironmentArgs(placedLaunchRoute(route))
  ]
}

function worktreeRemoveCommand(route: LaunchPlacementRoute, worktreeId: string): string {
  return cliCommand([
    resolveOrchestrationCliExecutable(),
    'worktree',
    'rm',
    '--worktree',
    `id:${worktreeId}`,
    ...launchEnvironmentArgs(placedLaunchRoute(route))
  ])
}

const UNVERIFIABLE_WORKSPACE_CODE = 'launch_workspace_unverifiable'

/**
 * A create whose answer was never recorded. Inside the host's dedupe window the same command
 * resends it safely; after it, or a host restart, a resend could make a second worktree.
 */
export function worktreeCreateUnverifiableRefusal(
  record: AgentLaunchRecord,
  placement: LaunchPlacement,
  why: string,
  /** Seconds the same command can still resend it; absent or 0 leaves only the inspect step. */
  retryWithinSeconds?: number
): RuntimeClientError {
  const inspectCommand = placementWorktreeListArgs(placement.chosen.route)
  const list = cliCommand(inspectCommand)
  const name = placement.workspacePlan.name ?? 'the launch worktree'
  const retry =
    retryWithinSeconds && retryWithinSeconds > 0
      ? [
          `Run the same command again within ${retryWithinSeconds} s; the host returns the same worktree.`
        ]
      : []
  const inspect = `Check ${list}; if ${name} is there, launch into it with --worktree id:<its id> instead of --project, otherwise add --again.`
  return launchRefusal(
    UNVERIFIABLE_WORKSPACE_CODE,
    `The fresh worktree ${name} for operation ${record.operationId} on ${placement.chosen.label} is unverifiable: ${why}. No session was launched. ${[...retry, retry.length ? `After that: ${inspect}` : inspect].join(' ')}`,
    {
      operationId: record.operationId,
      outcome: 'not-sent',
      inspectCommand,
      nextSteps: [...retry, inspect]
    }
  )
}

/**
 * The host answered the create with an error and forgot it, so the same command retries afresh.
 * A create can fail after `git worktree add`, so it names the check for a leftover checkout.
 */
export function worktreeCreateFailedRefusal(
  record: AgentLaunchRecord,
  placement: LaunchPlacement,
  failure: RuntimeClientError
): RuntimeClientError {
  const { route, label } = placement.chosen
  const inspectCommand = placementWorktreeListArgs(route)
  const name = placement.workspacePlan.name ?? 'the launch worktree'
  return launchRefusal(
    failure.code,
    `Creating the launch worktree ${name} on ${label} failed: ${failure.message}. No session was launched.`,
    {
      operationId: record.operationId,
      outcome: 'not-sent',
      inspectCommand,
      nextSteps: [
        `If ${cliCommand(inspectCommand)} lists ${name}, the failed create left it behind; remove it with ${worktreeRemoveCommand(route, '<its id>')}.`,
        'Fix the cause, then run the same command again; it stays on the same computer.'
      ]
    }
  )
}

/** A record this command's intent names but that carries no placement to follow. */
export function noLaunchPlacementRefusal(record: AgentLaunchRecord): RuntimeClientError {
  return new RuntimeClientError(
    'launch_outcome_unknown',
    `Operation ${record.operationId} has no recorded placement, so this run cannot follow it. Nothing new launched.`,
    { operationId: record.operationId, outcome: 'unverifiable', nextSteps: [] }
  )
}

/** A definitive refusal on the placed computer: stop, name the runner-up, report the orphan. */
export function withPlacementNextSteps(error: unknown, record: AgentLaunchRecord): unknown {
  const placement = record.placement
  const data = error instanceof RuntimeClientError ? (error.data as LaunchRefusalData | null) : null
  const definitive = data?.outcome === 'not-sent' || data?.outcome === 'not-started'
  // Why: an unconfirmed worktree create is not a refusal; it may have made the worktree.
  if (
    !placement ||
    !data ||
    !definitive ||
    (error as RuntimeClientError).code === UNVERIFIABLE_WORKSPACE_CODE
  ) {
    return error
  }
  const created = placement.createdWorktreeId
  const remove = created ? worktreeRemoveCommand(placement.chosen.route, created) : null
  const notes = [
    ...(placement.runnerUp
      ? [`Runner-up: ${placement.runnerUp.label}: ${placement.runnerUp.command}`]
      : ['No runner-up computer could take it.']),
    ...(remove
      ? [
          `The worktree created for this launch on ${placement.chosen.label} is kept; remove it with ${remove} if you do not retry.`
        ]
      : [])
  ]
  return new RuntimeClientError(
    (error as RuntimeClientError).code,
    `${(error as Error).message}\n${notes.join('\n')}`,
    {
      ...data,
      ...(placement.runnerUp ? { runnerUp: placement.runnerUp } : {}),
      ...(created && remove ? { createdWorktree: { id: created, removeCommand: remove } } : {}),
      nextSteps: [...(data.nextSteps ?? []), ...notes]
    }
  )
}
