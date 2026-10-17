import {
  CONVERSATION_PERSON_HANDOFF_ACTOR,
  CONVERSATION_TRANSCRIPT_TARGET_PATH
} from './console-conversation-person-handoff'
import type { ConsoleConversationFleetSourceFile } from './console-conversation-fleet-types'
import type { ConsoleWorkflowStep } from './console-workflow-types'
import type { SessionChainHandoffStep, SessionFollowUpDeliverables } from './session-follow-up-rule'
import { conversationFleetPortableHandoffDeliverables } from './conversation-fleet-handoff-paths'

export type ConversationFleetHandoffInputs = {
  sourceSummaryFile?: ConsoleConversationFleetSourceFile
  sourceDeliverableFiles?: ConsoleConversationFleetSourceFile[]
  sourceDeliverablePaths?: string[]
  sourceDeliverables?: SessionFollowUpDeliverables
  /** Present only when the session's owner consented to send the transcript.
   *  Its presence *is* the consent: no flag can turn the transcript on without
   *  the redacted file already captured and pinned. */
  sourceTranscript?: ConversationFleetTranscriptInput
}

export type ConversationFleetTranscriptInput = {
  file: ConsoleConversationFleetSourceFile
  messageCount: number
}

export const CONVERSATION_HANDOFF_MAX_SOURCE_FILES = 32
const CONVERSATION_HANDOFF_MAX_NOTE_BYTES = 8192

/** The hub caps a handoff body; say so rather than sending a clipped note. */
function appendTranscriptLine(note: string, input: ConversationFleetTranscriptInput): string {
  const appended = `${note}${note.trim() ? '\n\n' : ''}${conversationTranscriptNoteLine(input)}`
  if (new TextEncoder().encode(appended).byteLength > CONVERSATION_HANDOFF_MAX_NOTE_BYTES) {
    throw new Error(
      'The handoff note has no room left for the transcript line. Shorten the note, or turn the transcript off.'
    )
  }
  return appended
}

/** One human-readable line so the recipient knows the file is there and how big. */
export function conversationTranscriptNoteLine(input: ConversationFleetTranscriptInput): string {
  return `Transcript attached: ${input.file.file.name} (${input.messageCount} messages, ${formatTranscriptSize(input.file.file.size_bytes)})`
}

function formatTranscriptSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`
  }
  const kib = bytes / 1024
  return kib < 1024 ? `${kib.toFixed(1)} KiB` : `${(kib / 1024).toFixed(1)} MiB`
}

export function conversationFleetHandoffStages(
  step: SessionChainHandoffStep,
  after: string[],
  fromSource: boolean,
  sourceWorkspacePath: string,
  inputs: ConversationFleetHandoffInputs
): ConsoleWorkflowStep[] {
  const rule = step.handoff
  const selectedDeliverables = conversationFleetPortableHandoffDeliverables(
    rule.deliverables,
    sourceWorkspacePath
  )
  if (
    fromSource &&
    inputs.sourceDeliverables &&
    JSON.stringify(inputs.sourceDeliverables) !== JSON.stringify(selectedDeliverables)
  ) {
    throw new Error('The captured people handoff files differ from the selected deliverables.')
  }
  let deliverables = selectedDeliverables
  if (fromSource && selectedDeliverables.kind !== 'files') {
    if (!inputs.sourceDeliverablePaths?.length) {
      throw new Error(
        'Capture the exact files declared by the source handoff manifest before dispatching.'
      )
    }
    deliverables = conversationFleetPortableHandoffDeliverables(
      { kind: 'files', paths: inputs.sourceDeliverablePaths },
      sourceWorkspacePath
    )
  }
  const hasFiles = deliverables.kind !== 'files' || deliverables.paths.length > 0
  if (fromSource && hasFiles && !inputs.sourceDeliverableFiles?.length) {
    throw new Error(
      'Capture the exact selected people handoff files before reviewing the dispatch.'
    )
  }
  if (
    fromSource &&
    deliverables.kind === 'files' &&
    deliverables.paths.some(
      (path) => !inputs.sourceDeliverableFiles?.some((pin) => pin.target_path === path)
    )
  ) {
    throw new Error('The selected people handoff files have no matching frozen file versions.')
  }
  if (fromSource && rule.includeSummary && !inputs.sourceSummaryFile) {
    throw new Error(
      'The people handoff needs an exact captured assistant summary before dispatching.'
    )
  }
  if (rule.dueAt && Number.isNaN(Date.parse(rule.dueAt))) {
    throw new Error('The people handoff due date is invalid.')
  }
  const transcript = inputs.sourceTranscript
  if (transcript && deliverables.kind === 'files' && deliverables.paths.length) {
    // Never drop a chosen file silently: the transcript is its own deliverable.
    throw new Error(
      'A handoff sends either the session transcript or selected work files. Clear the selected files, or turn the transcript off.'
    )
  }
  const transcriptFile = transcript
    ? { ...transcript.file, target_path: CONVERSATION_TRANSCRIPT_TARGET_PATH }
    : null
  const note = transcript ? appendTranscriptLine(rule.note, transcript) : rule.note
  const sourceFiles = [
    ...(fromSource ? (inputs.sourceDeliverableFiles ?? []) : []),
    ...(transcriptFile ? [transcriptFile] : [])
  ]
  if (sourceFiles.length > CONVERSATION_HANDOFF_MAX_SOURCE_FILES) {
    throw new Error(
      `A people handoff carries at most ${CONVERSATION_HANDOFF_MAX_SOURCE_FILES} files; the transcript counts as one. Choose fewer work files.`
    )
  }
  return rule.recipients.map((recipient, index) => ({
    key: `${step.id}-person-${index + 1}`,
    title: `Deliver to ${recipient.name}`,
    actor_type: 'mechanical',
    actor_id: CONVERSATION_PERSON_HANDOFF_ACTOR,
    action: 'notify',
    brief: `Deliver the selected work from ${rule.sessionLabel} to ${recipient.name}. The receipt confirms delivery only; the person's requested response remains separate.\n\n${note}`,
    placement: 'fleet',
    acceptance_commands: [],
    after,
    ...(step.group ? { parallel_group: step.group } : {}),
    person_handoff: {
      version: 1,
      approved: true,
      recipient_employee_id: recipient.employeeId,
      task_id: rule.taskId,
      note,
      include_summary: rule.includeSummary,
      deliverables: transcript ? { kind: 'transcript' as const, include: true as const } : deliverables,
      ...(rule.action ? { action: rule.action } : {}),
      ...(rule.dueAt ? { due_at: rule.dueAt } : {}),
      ...(fromSource || transcriptFile ? { source_files: sourceFiles } : {}),
      ...(fromSource && rule.includeSummary ? { summary_file: inputs.sourceSummaryFile } : {})
    }
  }))
}
