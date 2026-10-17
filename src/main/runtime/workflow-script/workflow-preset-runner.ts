import { runCouncilProgram, type CouncilSeat } from './presets/council'
import { runAuditPreset, type AuditProgramPorts } from './audit/audit-host'
import { runCouncilV6Program } from './presets/council-v6'
import { runDiscoverProgram } from './presets/discover'
import { runDiscoverV7Program } from './presets/discover-v7'
import { discoverV7ConfigFromSnapshot } from './presets/discover-v7-config'
import type { WorkflowProgramContext } from './workflow-program-context'
import type { AnonymousCandidatePacket } from './workflow-working-artifacts'
import type { WorkflowProgramSnapshot } from './workflow-execution-service'
import { runWorkflowGraphProgram } from './graph/graph-program'
import {
  assertHarvestReplaySupported,
  assertScanReplaySupported,
  type GraphConfig
} from './graph/graph-plan-types'
import { assertImproveReplaySupported } from './graph/graph-improve-rules'
import { assertDecisionReplaySupported } from './graph/graph-decision-rules'
import { graphSnapshotRules } from './graph/graph-snapshot-rules'
import { graphJevJudgeForExecution } from './graph/graph-jev'
import { graphJevScreenerForExecution } from './graph/graph-jev-screen'
import { graphJevRouterForExecution } from './graph/graph-jev-route'
import { graphGitHubFactsForExecution } from './graph/graph-github-facts'
import { graphGitHubHarvestForExecution } from './graph/graph-github-harvest'
import { graphCheckerForExecution } from './graph/graph-check'
import { graphCheckLanesForRun } from './graph/graph-check-lane'
import { graphEvidenceCheckerForExecution } from './graph/graph-evidence-checker'
import { graphJevVerifierForExecution } from './graph/graph-jev-verify'
import { graphWebForExecution, graphWebReadersStarted } from './graph/graph-web-sources'
import type { WorkflowWebStarts } from './workflow-web-starts'
import { graphRunReadsWeb, graphWebRules } from './graph/graph-web-types'
import { assertWebReplaySupported } from './graph/graph-web-plan'
import { assertWorkflowWorkspaceRoot } from './local-workflow-workspace-root'
import { graphContextNoteFields } from './graph/graph-context-note'
import { graphEarlierFindings } from './workflow-earlier-findings'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { recordSettledGraphJudging } from './graph/graph-judging-gates'
import { graphSeatConfig, type GraphSeatCapacity } from './graph/graph-seat-substitution'
import type { GraphOutcome, GraphPlan } from './graph/graph-plan'
import {
  COUNCIL_REVISION,
  DISCOVER_REVISION,
  GRAPH_PROGRAM_REVISION,
  WORKING_COUNCIL_REVISION
} from './workflow-program-revisions'

/** Execution and reconciliation reconstruct exactly the same bundled program and validators. */
export function runWorkflowPreset(
  context: WorkflowProgramContext,
  preset: 'council' | 'discover',
  snapshot: WorkflowProgramSnapshot,
  working?: {
    candidatePacket: (
      seat: CouncilSeat,
      answer: unknown,
      label: string
    ) => Promise<AnonymousCandidatePacket>
  },
  graph: {
    audit?: AuditProgramPorts
    judgeWithJev?: GraphConfig['judgeWithJev']
    /** Replays recorded screens (recovery); otherwise a live run asks JEV. */
    screenWithJev?: GraphConfig['screenWithJev']
    /** Replays the recorded one-answer route (recovery); otherwise a live run asks JEV. */
    routeWithJev?: GraphConfig['routeWithJev']
    /** Replays recorded GitHub facts (recovery); otherwise a live run asks GitHub. */
    fetchFacts?: GraphConfig['fetchFacts']
    /** Replays the recorded GitHub search (recovery); otherwise a live run searches. */
    harvestGitHub?: GraphConfig['harvestGitHub']
    /** Replays recorded checks (recovery); otherwise a live run checks in its workspace. */
    checkCandidate?: GraphConfig['checkCandidate']
    /** Replays recorded quote checks (recovery); otherwise a live run reads its workspace. */
    checkEvidence?: GraphConfig['checkEvidence']
    /** Replays recorded shadow verifies (recovery); otherwise a live run asks JEV. */
    verifyWithJev?: GraphConfig['verifyWithJev']
    /** Replays recorded web pages (recovery); else a run admitted under web rules reads them. */
    readWeb?: GraphConfig['readWeb']
    /** The checkpoint's recorded calls, so a reader already run proves its pages were kept. */
    recorded?: () => readonly string[]
    /** The checkpoint's record of web calls that began fetching (workflow-web-starts.ts). */
    webStarts?: WorkflowWebStarts
    /** The run whose JEV ballots are asked for and kept (replay-only runs never ask). */
    jev?: { executionId: string; cacheOnly?: boolean }
    refused?: GraphConfig['refused']
    /** A live run's account capacity now, so a call that failed at launch can move (seat rules). */
    seatCapacity?: GraphSeatCapacity
    /** A live run's Stop and process slots, which its checks share with its agents. */
    processes?: {
      signal: AbortSignal
      slot: <T>(work: () => Promise<T>) => Promise<T>
    }
  } = {}
) {
  if (snapshot.version !== 1) {
    throw new Error('Unsupported workflow program snapshot')
  }
  if (snapshot.audit) {
    return runAuditPreset(context, preset, snapshot, graph)
  }
  if (snapshot.graphProgramRevision !== undefined) {
    if (snapshot.graphProgramRevision !== GRAPH_PROGRAM_REVISION || !snapshot.graph) {
      throw new Error('Unsupported workflow graph revision')
    }
    assertScanReplaySupported(snapshot.graph.spec, snapshot)
    assertHarvestReplaySupported(snapshot.graph.spec, snapshot)
    assertImproveReplaySupported(snapshot.graph.spec, snapshot)
    assertWebReplaySupported(snapshot.graph.spec, graphWebRules(snapshot).webRules)
    assertDecisionReplaySupported(snapshot.graph.spec, snapshot)
    const host = snapshot as Pick<LocalWorkflowHostSnapshot, 'host'>
    // Only a live run gets private copies: a replay never makes one or runs anything in it.
    const lanes =
      graph.jev && !graph.jev.cacheOnly && !graph.checkCandidate
        ? graphCheckLanesForRun(
            graph.jev.executionId,
            { ...host, graph: snapshot.graph },
            graph.processes?.signal
          )
        : undefined
    const running = runWorkflowGraphProgram(
      context,
      {
        spec: snapshot.graph.spec,
        seats: snapshot.seats,
        agentSeats: snapshot.graph.agentSeats,
        access: snapshot.access === 'workspace-read' ? 'workspace-read' : 'frozen',
        ...graphContextNoteFields(host),
        ...graphEarlierFindings(host),
        ...graphSnapshotRules(snapshot),
        ...graphSeatConfig({ ...snapshot, graph: snapshot.graph }, graph),
        ...(graph.refused ? { refused: graph.refused } : {}),
        ...(graph.judgeWithJev || graph.jev
          ? {
              judgeWithJev:
                graph.judgeWithJev ??
                graphJevJudgeForExecution(graph.jev!.executionId, {
                  cacheOnly: graph.jev!.cacheOnly,
                  log: context.log
                })
            }
          : {}),
        ...(graph.screenWithJev || graph.jev
          ? {
              screenWithJev:
                graph.screenWithJev ??
                graphJevScreenerForExecution(graph.jev!.executionId, {
                  cacheOnly: graph.jev!.cacheOnly,
                  log: context.log
                })
            }
          : {}),
        ...(graph.routeWithJev || graph.jev
          ? {
              routeWithJev:
                graph.routeWithJev ??
                graphJevRouterForExecution(graph.jev!.executionId, {
                  cacheOnly: graph.jev!.cacheOnly,
                  log: context.log
                })
            }
          : {}),
        ...(graph.fetchFacts || graph.jev
          ? {
              fetchFacts:
                graph.fetchFacts ??
                graphGitHubFactsForExecution(graph.jev!.executionId, {
                  cacheOnly: graph.jev!.cacheOnly,
                  log: context.log,
                  ...(graph.processes ? { signal: graph.processes.signal } : {})
                })
            }
          : {}),
        ...(graph.harvestGitHub
          ? { harvestGitHub: graph.harvestGitHub }
          : graph.jev && snapshot.graph.spec.find?.harvest
            ? {
                harvestGitHub: graphGitHubHarvestForExecution(graph.jev.executionId, {
                  cacheOnly: graph.jev.cacheOnly,
                  log: context.log,
                  ...(graph.processes ? { signal: graph.processes.signal } : {})
                })
              }
            : {}),
        ...(graph.checkCandidate
          ? { checkCandidate: graph.checkCandidate }
          : graph.jev && (snapshot.graph.spec.repeat?.check || snapshot.graph.spec.find?.check)
            ? {
                checkCandidate: graphCheckerForExecution(graph.jev.executionId, {
                  ...(graph.jev.cacheOnly ? { cacheOnly: true } : {}),
                  ...graph.processes,
                  ...(lanes ? { lanes } : {}),
                  workspace: () => assertWorkflowWorkspaceRoot(host)
                })
              }
            : {}),
        ...(graph.checkEvidence
          ? { checkEvidence: graph.checkEvidence }
          : graph.jev && snapshot.graph.spec.steps.some((step) => step.list?.evidence)
            ? {
                checkEvidence: graphEvidenceCheckerForExecution(graph.jev.executionId, {
                  ...(graph.jev.cacheOnly ? { cacheOnly: true } : {}),
                  log: context.log,
                  workspace: () =>
                    assertWorkflowWorkspaceRoot(snapshot as Pick<LocalWorkflowHostSnapshot, 'host'>)
                })
              }
            : {}),
        ...(graph.verifyWithJev
          ? { verifyWithJev: graph.verifyWithJev }
          : graph.jev && snapshot.graph.spec.steps.some((step) => step.jevVerify)
            ? {
                verifyWithJev: graphJevVerifierForExecution(graph.jev.executionId, {
                  ...(graph.jev.cacheOnly ? { cacheOnly: true } : {}),
                  log: context.log,
                  workspace: () => assertWorkflowWorkspaceRoot(host)
                })
              }
            : {}),
        ...(graph.readWeb
          ? { readWeb: graph.readWeb }
          : graph.jev && graphRunReadsWeb(snapshot)
            ? {
                readWeb: graphWebForExecution(graph.jev.executionId, {
                  ...(graph.jev.cacheOnly ? { cacheOnly: true } : {}),
                  ...(graph.recorded ? graphWebReadersStarted(snapshot, graph.recorded) : {}),
                  ...(graph.webStarts ? { starts: graph.webStarts } : {}),
                  log: context.log,
                  ...(graph.processes ? { signal: graph.processes.signal } : {})
                })
              }
            : {}),
        ...(graph.jev && !graph.jev.cacheOnly
          ? {
              onSettled: (plan: GraphPlan, outcomes: ReadonlyMap<string, GraphOutcome>) => {
                void lanes?.dispose()
                recordSettledGraphJudging(
                  { seats: snapshot.seats, graph: snapshot.graph!, task: snapshot.task },
                  graph.jev!.executionId,
                  plan,
                  outcomes
                )
              }
            }
          : {})
      },
      snapshot.task
    )
    // A stopped or failed run removes its copies too; a crash leaves them for the next sweep.
    return lanes ? running.finally(() => void lanes.dispose()) : running
  }
  const synthesizer = snapshot.seats.find((seat) => seat.id === snapshot.synthesizerId)
  if (!synthesizer) {
    throw new Error('Missing frozen workflow synthesizer')
  }
  if (
    snapshot.councilProgramRevision !== undefined &&
    ![1, 2, 3, 4, 5, COUNCIL_REVISION].includes(snapshot.councilProgramRevision)
  ) {
    throw new Error('Unsupported Council program revision')
  }
  if (preset === 'council' && snapshot.councilProgramRevision === undefined && 'host' in snapshot) {
    throw new Error('Unversioned host Council requires call-evidence resolution')
  }
  if (
    snapshot.discoverProgramRevision !== undefined &&
    ![1, 2, 3, 4, 5, 6, DISCOVER_REVISION].includes(snapshot.discoverProgramRevision)
  ) {
    throw new Error('Unsupported Discover program revision')
  }
  const access = snapshot.access === 'workspace-read' ? 'workspace-read' : 'frozen'
  if (preset === 'council' && snapshot.councilProgramRevision === COUNCIL_REVISION) {
    return runCouncilV6Program(
      context,
      {
        seats: snapshot.seats,
        memberIds: snapshot.council?.memberIds ?? [],
        chairId: snapshot.synthesizerId,
        access
      },
      snapshot.task
    )
  }
  if (preset === 'discover' && snapshot.discoverProgramRevision === DISCOVER_REVISION) {
    // Shared with the projection so the live view replays exactly this config.
    return runDiscoverV7Program(context, discoverV7ConfigFromSnapshot(snapshot), snapshot.task)
  }
  const councilRevision = (snapshot.councilProgramRevision ?? 4) as 1 | 2 | 3 | 4 | 5
  const discoverRevision = snapshot.discoverProgramRevision as 1 | 2 | 3 | 4 | 5 | 6 | undefined
  return preset === 'council'
    ? runCouncilProgram(
        context,
        {
          panel: snapshot.seats,
          synthesizerId: snapshot.synthesizerId,
          revision: councilRevision,
          ...(councilRevision === WORKING_COUNCIL_REVISION
            ? {
                blindLabels: snapshot.councilBlindLabels,
                candidatePacket: working?.candidatePacket
              }
            : {})
        },
        snapshot.task
      )
    : runDiscoverProgram(
        context,
        {
          ...snapshot.discover!,
          revision: discoverRevision ?? 1,
          finder: snapshot.seats[0],
          skeptics: snapshot.seats.slice(1),
          synthesizer
        },
        snapshot.task
      )
}
