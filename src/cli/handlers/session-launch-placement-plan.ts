import {
  launchCandidateBand,
  launchCandidateRemainingPercent,
  launchCandidateSummary,
  rankLaunchCandidates,
  type LaunchPlacementRanking
} from '../../shared/agent-launch-placement'
import {
  LAUNCH_PLACEMENT_RULE,
  type LaunchCandidate,
  type LaunchPlacement,
  type LaunchPlacementChosen,
  type LaunchPlacementProject,
  type LaunchPlacementRoute,
  type LaunchPlacementRunnerUp,
  type LaunchWorkspacePlan
} from '../../shared/agent-launch-placement-types'
import { emptyLaunchManifest, launchManifestReport } from '../../shared/launch-manifest'
import { getOptionalStringFlag } from '../flags'
import { listSshTargets } from '../host-selector-alternatives'
import { launchFlagsAsTyped } from '../launch-host-name'
import { readLaunchCandidates, resolveLaunchProject } from '../launch-candidate-reader'
import type { LaunchPlacementClients } from '../launch-placement-clients'
import { noComputerRefusal, placedLaunchRoute } from '../launch-placement-refusals'
import {
  launchPlacementHostFlag,
  launchPlacementRouteAllowed,
  resolveLaunchPlacementHostFilter
} from '../launch-placement-target'
import { launchWorktreeName, launchWorktreeNameBase } from '../launch-placement-worktree'
import type { AgentLaunchRecord } from '../session-launch-record'
import { quoteCliCommandArgument } from '../shell-command-quote'
import type { LaunchInput } from './session-launch-input'
import { launchRetryCommand } from './session-launch-receipt'

export type PlacedLaunchRecord = AgentLaunchRecord & { placement: LaunchPlacement }

/** One read of the fleet, ranked; frozen into the record only when a launch goes ahead. */
export type RankedLaunchPlacement = {
  project: LaunchPlacementProject
  rankedAt: number
  ranking: LaunchPlacementRanking
  runnerUp: LaunchPlacementRunnerUp | null
}

// Why: the same command pinned to the runner-up's computer, so it re-ranks only there.
function runnerUpCommand(flags: Map<string, string | boolean>, host: string): string {
  const pinned = new Map([...launchFlagsAsTyped(flags), ['host', host]])
  return launchRetryCommand(pinned).map(quoteCliCommandArgument).join(' ')
}

/**
 * Reads every candidate once (read-only, the shared reader `omni host list --capacity` uses) and
 * ranks them. --host next to --project keeps only that computer's routes.
 */
export async function rankLaunchPlacement(args: {
  flags: Map<string, string | boolean>
  input: LaunchInput
  clients: LaunchPlacementClients
}): Promise<RankedLaunchPlacement> {
  const { flags, input, clients } = args
  const local = clients.local()
  const project = await resolveLaunchProject(input.project!, local)
  const environments = clients.environments()
  const sshTargets = await listSshTargets(local)
  const only = resolveLaunchPlacementHostFilter(
    getOptionalStringFlag(launchFlagsAsTyped(flags), 'host'),
    environments,
    sshTargets
  )
  const readings = await readLaunchCandidates(
    {
      provider: input.provider,
      model: input.model ?? null,
      project,
      readOldRuntimeAccounts: false,
      only: (route: LaunchPlacementRoute) => launchPlacementRouteAllowed(only, route)
    },
    {
      now: clients.now,
      local,
      environment: clients.environment,
      environments,
      listSshTargets: async () => sshTargets
    }
  )
  const ranking = rankLaunchCandidates(
    readings.map((reading) => reading.candidate),
    { provider: input.provider, project: project.identityKey }
  )
  const runner = ranking.runnerUp
  return {
    project,
    rankedAt: clients.now(),
    ranking,
    runnerUp: runner
      ? {
          label: runner.label,
          route: runner.route,
          command: runnerUpCommand(
            flags,
            launchPlacementHostFlag(runner.route, environments, sshTargets)
          )
        }
      : null
  }
}

export function assertLaunchPlacementChosen(
  ranked: RankedLaunchPlacement,
  input: LaunchInput
): LaunchCandidate {
  const { chosen } = ranked.ranking
  if (!chosen) {
    throw noComputerRefusal({
      provider: input.provider,
      project: ranked.project,
      candidates: ranked.ranking.candidates.map(launchCandidateSummary)
    })
  }
  return chosen
}

function chosenPlacement(candidate: LaunchCandidate, why: string): LaunchPlacementChosen {
  const { route } = candidate
  return {
    machineId: candidate.machineId,
    route,
    ...(route.kind === 'environment' ? { environmentId: route.environmentId } : {}),
    hostId: candidate.hostId!,
    runtimeId: candidate.runtimeId!,
    label: candidate.label,
    setup: candidate.setup!,
    remainingPercent: launchCandidateRemainingPercent(candidate) ?? 0,
    band: launchCandidateBand(candidate),
    why
  }
}

/**
 * The placement as the record freezes it. With no operation yet (a dry run) the worktree name
 * shows where the operation id's suffix goes.
 */
export function freezeLaunchPlacement(
  ranked: RankedLaunchPlacement,
  input: LaunchInput,
  operationId: string | null
): LaunchPlacement {
  const chosen = assertLaunchPlacementChosen(ranked, input)
  const setup = chosen.setup!
  const base = launchWorktreeNameBase(input)
  const workspacePlan: LaunchWorkspacePlan =
    setup.kind === 'git'
      ? {
          kind: 'new-worktree',
          repoSelector: `id:${setup.repoId}`,
          name: operationId
            ? launchWorktreeName(base, operationId)
            : `${base || 'launch'}-<last 6 of the operation id>`
        }
      : { kind: 'folder', path: setup.path }
  return {
    rule: LAUNCH_PLACEMENT_RULE,
    rankedAt: ranked.rankedAt,
    project: ranked.project,
    chosen: chosenPlacement(chosen, ranked.ranking.why),
    runnerUp: ranked.runnerUp,
    candidates: ranked.ranking.candidates.map(launchCandidateSummary),
    workspacePlan
  }
}

/** Written before the worktree create: everything a re-run needs to continue, and no request yet. */
export function placingLaunchRecord(args: {
  input: LaunchInput
  intentKey: string
  placement: LaunchPlacement
  operationId: string
  now: number
}): PlacedLaunchRecord {
  const { input, placement, operationId, now } = args
  const { chosen } = placement
  const route = placedLaunchRoute(chosen.route)
  return {
    v: 1,
    operationId,
    minted: true,
    intentKey: args.intentKey,
    createdAt: now,
    route,
    executingRuntimeId: chosen.runtimeId,
    hostId: chosen.hostId,
    hostLabel: chosen.label,
    request: null,
    post: {
      ...(input.title ? { title: input.title } : {}),
      ...(input.titleOrigin ? { titleOrigin: input.titleOrigin } : {}),
      folderId: null,
      ...(input.contract ? { contract: { ...input.contract, agent: input.provider } } : {}),
      done: false
    },
    sends: [],
    outcome: 'pending',
    summary: {
      host: {
        route:
          route.kind === 'environment' ? 'paired' : chosen.hostId === 'local' ? 'local' : 'ssh',
        name: chosen.label,
        ...(route.kind === 'environment' ? { environmentId: route.environmentId } : {}),
        hostId: chosen.hostId,
        runtimeId: chosen.runtimeId,
        appVersion: null,
        why: chosen.why,
        alsoReachableAs: [],
        visibleIn: ''
      },
      workspace: {
        selector: chosen.setup.selector,
        kind: chosen.setup.kind,
        hostId: chosen.hostId
      },
      manifest: launchManifestReport(emptyLaunchManifest(input.prompt)),
      warnings: []
    },
    placement
  }
}
