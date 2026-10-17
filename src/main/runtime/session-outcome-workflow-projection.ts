import { isDeepStrictEqual } from 'node:util'
import { verifiedSessionOutcomeCurrentReviews } from './session-outcome-workflow-current-proof'
import { sessionOutcomeExternalProducer } from './session-outcome-workflow-external-producer'
import { hasSessionOutcomeCanonicalProjection } from './session-outcome-workflow-seal'
import type { ConsoleWorkflowJob } from '../../shared/console-workflow-types'
import type {
  SessionOutcomeStageReceipt,
  SessionOutcomeWorkflow
} from '../../shared/session-outcome-workflow'

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
/** Hub acceptance and selector evidence are required; worker_done and an empty branch are insufficient. */
export type ClosedSessionOutcomeStage = {
  key: string
  reviews: SessionOutcomeStageReceipt[]
  producer?: SessionOutcomeStageReceipt
  round?: number
  verificationReportId: string
  evidenceId?: string
}
export function closedSessionOutcomeStages(
  workflow: SessionOutcomeWorkflow,
  jobs: ConsoleWorkflowJob[],
  history: SessionOutcomeWorkflow[] = []
): ClosedSessionOutcomeStage[] {
  const receipts = (workflow.receipts ?? []).filter((receipt) => {
    const job = jobs.find((entry) => entry.id === receipt.jobId)
    const projection = job?.policy.workflow.hub_projection
    const node = workflow.preview.graph.nodes.find((entry) => entry.key === receipt.key)
    return (
      job &&
      (!node?.current_source ||
        (isDeepStrictEqual(job.policy.workflow.current_source, node.current_source) &&
          job.attempt === receipt.attempt &&
          job.lease_generation === receipt.leaseGeneration)) &&
      job.task_id === receipt.taskId &&
      job.policy.workflow.key === receipt.key &&
      job.provider === receipt.provider &&
      job.model === receipt.model &&
      hasSessionOutcomeCanonicalProjection(projection, workflow.canonicalSeal) &&
      projection?.satisfied === true &&
      projection.verification_report_id === receipt.verificationReportId
    )
  })
  return workflow.stages.flatMap<ClosedSessionOutcomeStage>((stage) => {
    const node =
      workflow.preview.graph.nodes.find((entry) => entry.key === stage.key) ??
      workflow.preview.graph.nodes.find((entry) => entry.loop_stage?.stage_key === stage.key)
    if (!node) {
      return []
    }
    const loop = node.loop_stage
    if (!loop) {
      const job = jobs.find((entry) => entry.policy.workflow.key === stage.key)
      const receipt = receipts.find((entry) => entry.jobId === job?.id)
      return receipt
        ? [{ key: stage.key, reviews: [], verificationReportId: receipt.verificationReportId }]
        : []
    }
    const deciders = workflow.preview.graph.nodes.filter(
      (entry) => entry.loop_stage?.stage_key === stage.key && entry.loop_stage?.role === 'decide'
    )
    for (const decider of deciders) {
      const job = jobs.find((entry) => entry.policy.workflow.key === decider.key)
      const projection = job?.policy.workflow.hub_projection
      const input = decider.mechanical_execution?.input
      const expected = input?.closed_node_keys
      if (
        !job ||
        !projection ||
        projection.satisfied !== true ||
        !hasSessionOutcomeCanonicalProjection(projection, workflow.canonicalSeal) ||
        !Array.isArray(expected)
      ) {
        continue
      }
      const rows = expected.length
        ? projection.branch_resolutions
        : projection.terminal_loop_resolutions
      if (!Array.isArray(rows)) {
        continue
      }
      const closure = rows
        .map(object)
        .find(
          (row) =>
            row &&
            row.revision_id === projection.revision_id &&
            row.selector_node_key === decider.key &&
            row.branch_group === decider.loop_stage?.branch_group &&
            row.verification_report_id === projection.verification_report_id &&
            typeof row.evidence_id === 'string' &&
            row.evidence_id.length > 0 &&
            Array.isArray(row.selected_node_keys) &&
            JSON.stringify([...row.selected_node_keys].sort()) ===
              JSON.stringify([...expected].sort()) &&
            (expected.length > 0 || row.decision === 'closed')
        )
      if (!closure) {
        continue
      }
      const participants = workflow.preview.graph.nodes.filter(
        (entry) =>
          entry.loop_stage?.stage_key === stage.key &&
          entry.loop_stage?.role === 'participant' &&
          entry.loop_stage?.round === decider.loop_stage?.round
      )
      if (
        !Array.isArray(input?.participant_node_keys) ||
        JSON.stringify([...input.participant_node_keys].sort()) !==
          JSON.stringify(participants.map((entry) => entry.key).sort())
      ) {
        continue
      }
      const accepted = participants.map((participant) => {
        const participantJob = jobs.find((entry) => entry.policy.workflow.key === participant.key)
        return receipts.find(
          (receipt) =>
            receipt.jobId === participantJob?.id &&
            receipt.provider === participant.provider &&
            receipt.model === participant.model
        )
      })
      if (
        !accepted.length ||
        accepted.some(
          (receipt) =>
            !receipt ||
            receipt.verdict?.verdict !== 'agree' ||
            receipt.verdict.blockers.length ||
            receipt.verdict.gaps.length ||
            (!decider.current_source &&
              (!receipt.candidateSha || !receipt.verdict.notes.includes(receipt.candidateSha)))
        )
      ) {
        continue
      }
      if (decider.current_source) {
        if (
          !verifiedSessionOutcomeCurrentReviews(
            workflow,
            decider,
            participants,
            accepted as SessionOutcomeStageReceipt[],
            receipts
          )
        ) {
          continue
        }
        return [
          {
            key: stage.key,
            reviews: accepted as SessionOutcomeStageReceipt[],
            round: Number(decider.loop_stage?.round),
            verificationReportId: String(closure.verification_report_id),
            evidenceId: String(closure.evidence_id)
          }
        ]
      }
      const candidateShas = accepted.map((receipt) => receipt!.candidateSha)
      if (new Set(candidateShas).size !== 1) {
        continue
      }
      const producerNodes = workflow.preview.graph.nodes
        .filter(
          (entry) =>
            entry.loop_stage?.stage_key === stage.key &&
            (entry.loop_stage?.role === 'producer' || entry.loop_stage?.role === 'repair') &&
            Number(entry.loop_stage?.round) === Number(decider.loop_stage?.round) - 1
        )
        .sort((a, b) => Number(b.loop_stage?.round) - Number(a.loop_stage?.round))
      const producerJob = jobs.find((entry) => entry.policy.workflow.key === producerNodes[0]?.key)
      const producerReceipt =
        receipts.find((entry) => entry.jobId === producerJob?.id) ??
        (decider.loop_stage?.round === 1
          ? sessionOutcomeExternalProducer(workflow, decider, history)
          : undefined)
      if (
        !producerReceipt?.branch ||
        !producerReceipt.prUrl ||
        producerReceipt.candidateSha !== candidateShas[0]
      ) {
        continue
      }
      return [
        {
          key: stage.key,
          reviews: accepted as SessionOutcomeStageReceipt[],
          producer: producerReceipt,
          round: Number(decider.loop_stage?.round),
          verificationReportId: String(closure.verification_report_id),
          evidenceId: String(closure.evidence_id)
        }
      ]
    }
    return []
  })
}
