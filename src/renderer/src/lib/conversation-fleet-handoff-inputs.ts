import type { ExactHandoffFile } from '../../../shared/console-handoff-contract'
import type { NextStepHandoffOptions } from '../../../shared/next-step-draft'
import type { SessionFollowUpDeliverables } from '../../../shared/session-follow-up-rule'
import { conversationFleetPortableHandoffDeliverables } from '../../../shared/conversation-fleet-handoff-paths'
import type { CaptureFleetSourceResult } from '../../../shared/conversation-fleet-source-snapshot'
import type { CapturedConversationFleetContext } from './conversation-fleet-context'
import { conversationFleetTextFiles } from './conversation-fleet-text-files'

export type ConversationFleetHandoffSourceOptions = Pick<
  NextStepHandoffOptions,
  'includeSummary' | 'deliverables'
>
export type ConversationFleetHandoffSource = {
  deliverables: SessionFollowUpDeliverables
  summary?: ExactHandoffFile
}

export function conversationFleetHandoffDeliveryPaths(
  snapshot: Pick<CaptureFleetSourceResult, 'deliverables' | 'deliverablePaths'>
): string[] {
  const rule = snapshot.deliverables
  const manifests = new Set(
    rule?.kind === 'manifest'
      ? [rule.manifestPath]
      : rule?.kind === 'manifests'
        ? rule.manifestPaths
        : []
  )
  return (snapshot.deliverablePaths ?? []).filter((path) => !manifests.has(path))
}

const SUMMARY_MAX_BYTES = 1024 * 1024

export async function prepareConversationFleetHandoffSource(
  context: CapturedConversationFleetContext,
  options?: ConversationFleetHandoffSourceOptions
): Promise<ConversationFleetHandoffSource | null> {
  if (!options) {
    return null
  }
  const deliverables = conversationFleetPortableHandoffDeliverables(
    options.deliverables ?? { kind: 'files', paths: [] },
    context.sourceWorkspacePath
  )
  if (!options.includeSummary) {
    return { deliverables }
  }
  if (!context.sourceSummary?.trim()) {
    throw new Error(
      'No assistant summary is available yet. Turn off Include summary or wait for an assistant response before preparing this handoff.'
    )
  }
  if (new TextEncoder().encode(context.sourceSummary).length > SUMMARY_MAX_BYTES) {
    throw new Error(
      'The complete assistant summary exceeds the handoff’s 1 MiB limit. Turn off Include summary and choose deliverable files instead. Its text was not truncated.'
    )
  }
  const captured = await conversationFleetTextFiles(
    context.sourceSummary,
    'source-assistant-answer',
    'md'
  )
  return { deliverables, summary: captured.files[0] }
}

export function verifyConversationFleetHandoffSource(
  expected: ConversationFleetHandoffSource | null,
  snapshot: Pick<CaptureFleetSourceResult, 'deliverables' | 'deliverablePaths'> & {
    files: { targetPath: string }[]
  }
): void {
  if (!expected) {
    return
  }
  if (
    JSON.stringify(snapshot.deliverables) !== JSON.stringify(expected.deliverables) ||
    !snapshot.deliverablePaths
  ) {
    throw new Error(
      'The source host did not capture the requested handoff files. Update Orca on that host and prepare the handoff again.'
    )
  }
  if (
    snapshot.deliverablePaths.some(
      (path) => !snapshot.files.some((file) => file.targetPath === path)
    )
  ) {
    throw new Error('A declared handoff file was not captured. Prepare the complete handoff again.')
  }
  if (expected.deliverables.kind === 'files') {
    const requested = new Set(expected.deliverables.paths)
    if (
      requested.size !== snapshot.deliverablePaths.length ||
      snapshot.deliverablePaths.some((path) => !requested.has(path))
    ) {
      throw new Error(
        'The source host changed the selected handoff files. Prepare the handoff again.'
      )
    }
  }
}
