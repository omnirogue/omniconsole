import type { LocalWorkflowStartRequest } from '../../../shared/local-workflow-rpc'
import { realpath } from 'node:fs/promises'
import { localWorkflowAuditDraftSchema } from '../../../shared/workflow-audit-draft'
import {
  resolveLocalWorkflowSeat,
  type LocalWorkflowSeatCatalog
} from '../../../shared/local-workflow-seats'
import { mayIssueVerdict } from '../../../shared/model-lineage'
import type { LocalWorkflowWorkspace } from './local-workflow-host-options'
import type { LocalWorkflowGraphAdmission } from './local-workflow-graph-admission'
import { assertWorkflowContextPath } from './context/context-source-check'
import {
  auditCallLimit,
  AUDIT_PROGRAM_REVISION,
  captureAuditCorpus,
  validateAuditSnapshot,
  type AuditSnapshot
} from './audit/audit-snapshot'

/** All source reads belong to this host; a fleet choice must fail before opening the file. */
export async function prepareAuditWorkflowAdmission(input: {
  request: LocalWorkflowStartRequest
  workspace: LocalWorkflowWorkspace
  requestDigest: string
  slotLimit: number
  catalog: () => Promise<LocalWorkflowSeatCatalog[]>
  appData?: string
}): Promise<LocalWorkflowGraphAdmission> {
  const { request, workspace } = input
  const draft = request.draft
  const selection = localWorkflowAuditDraftSchema.parse(draft.audit)
  if (
    request.preset !== 'discover' ||
    draft.graph ||
    draft.capability === 'working-agent' ||
    draft.access !== 'frozen' ||
    draft.scopeIds.length ||
    draft.contextSources?.length ||
    draft.includeWorkspace ||
    draft.outputFileName
  ) {
    throw new Error('Audit reads the selected corpus only. Open a new Audit workflow.')
  }
  if (
    workspace.executionHost !== 'local' ||
    draft.runsOn !== 'local' ||
    draft.runsOnHost ||
    draft.runsOnHostId ||
    draft.forceHost
  ) {
    throw new Error(
      'Start Audit on the computer holding the corpus. Fleet corpus transfer is unavailable.'
    )
  }
  if (!draft.prompt.trim() || draft.prompt.length > 32_000) {
    throw new Error('Enter an audit question of at most 32,000 characters.')
  }
  if (
    !Number.isInteger(draft.concurrency) ||
    draft.concurrency < 1 ||
    draft.concurrency > input.slotLimit
  ) {
    throw new Error('Invalid workflow concurrency.')
  }
  if (
    !draft.seats.length ||
    draft.seats.length > 8 ||
    new Set(draft.seats.map((seat) => seat.id)).size !== draft.seats.length
  ) {
    throw new Error('Choose one to eight distinct audit seats.')
  }
  const catalog = await input.catalog()
  const seats = draft.seats.map((seat) => resolveLocalWorkflowSeat(seat, catalog))
  const judges = seats.filter((seat) => mayIssueVerdict(seat.agent, seat.model))
  if (!judges.length) {
    throw new Error('Audit needs at least one model eligible to review evidence and plans.')
  }
  const source = await assertWorkflowContextPath(selection.sourceFile, {
    appData: input.appData ? await realpath(input.appData) : undefined
  })
  if (source.directory) {
    throw new Error('Choose a corpus JSONL file, not a folder.')
  }
  const captured = captureAuditCorpus(source.path, selection.format)
  const audit: AuditSnapshot = {
    version: AUDIT_PROGRAM_REVISION,
    ...captured,
    readerSeatId: seats[0].id,
    reviewerSeatId: judges.find((seat) => seat.id !== seats[0].id)?.id ?? judges[0].id,
    plannerSeatIds: Array.from({ length: 3 }, (_, index) => seats[index % seats.length].id),
    judgeSeatIds: Array.from({ length: 2 }, (_, index) => judges[index % judges.length].id),
    synthesizerSeatId: judges[0].id,
    clusterGroups: Math.min(4, captured.corpus.chunks.length),
    agreementSamples: Math.min(2, captured.corpus.chunks.length),
    noveltyLenses: [
      'Missed requests and recurring manual work',
      'Contradictions and already-solved problems'
    ],
    maxThemes: 12,
    existingFindings: [],
    ...(selection.reference ? { reference: selection.reference } : {})
  }
  validateAuditSnapshot(audit, seats)
  const callLimit = auditCallLimit(audit)
  return {
    preset: 'discover',
    callLimit,
    attemptLimit: 3,
    budgetLimit: callLimit * 3,
    snapshot: {
      version: 1,
      audit,
      capability: { mode: 'frozen-analysis', revision: 1 },
      limits: { concurrency: draft.concurrency },
      task: { prompt: draft.prompt.trim(), evidence: '' },
      seats,
      synthesizerId: audit.synthesizerSeatId,
      host: {
        workspaceId: workspace.id,
        conversationId: request.conversationId,
        requestDigest: input.requestDigest,
        startedAt: Date.now(),
        concurrency: draft.concurrency,
        sources: captured.corpus.sources.map((item) => ({
          ref: item.id,
          description: item.timestamp
        })),
        coverage: [
          `${captured.corpus.sources.length} sources in ${captured.corpus.chunks.length} disjoint chunks`,
          'Only the selected corpus is supplied to agents; source checks run on this computer.'
        ]
      }
    }
  }
}
