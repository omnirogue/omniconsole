import { describe, expect, it } from 'vitest'
import {
  conversationFleetHandoffStages,
  conversationTranscriptNoteLine,
  type ConversationFleetHandoffInputs,
  type ConversationFleetTranscriptInput
} from './conversation-fleet-handoff'
import {
  conversationPersonHandoffRequest,
  CONVERSATION_TRANSCRIPT_TARGET_PATH
} from './console-conversation-person-handoff'
import type { ConsoleConversationFleetSourceFile } from './console-conversation-fleet-types'
import type { SessionChainHandoffStep, SessionFollowUpDeliverables } from './session-follow-up-rule'

const transcriptPin: ConsoleConversationFleetSourceFile = {
  kind: 'task_file',
  task_id: 'btk_abcdefgh',
  file: {
    rel: 'uploads/transcript-ses_abc123-20260913.md',
    name: 'transcript-ses_abc123-20260913.md',
    sha256: 'e'.repeat(64),
    size_bytes: 4096
  }
}

const transcript: ConversationFleetTranscriptInput = { file: transcriptPin, messageCount: 12 }

function step(
  deliverables: SessionFollowUpDeliverables,
  note = 'Please read this.'
): SessionChainHandoffStep {
  return {
    kind: 'handoff',
    id: 'step-1',
    status: 'queued',
    handoff: {
      revision: 1,
      taskId: 'btk_abcdefgh',
      taskTitle: 'Room plan',
      sessionLabel: 'Transcript handoff',
      recipients: [
        { employeeId: 'emp_uma', name: 'Uma', operationId: 'op_abcdefgh', delivery: 'pending' }
      ],
      deliverables,
      includeSummary: false,
      note,
      savedAt: 0
    }
  }
}

function stages(
  deliverables: SessionFollowUpDeliverables,
  inputs: ConversationFleetHandoffInputs,
  note?: string
) {
  return conversationFleetHandoffStages(step(deliverables, note), [], false, '/work/repo', inputs)
}

describe('conversationFleetHandoffStages with a transcript', () => {
  it('leaves an ordinary handoff untouched', () => {
    const [stage] = stages({ kind: 'files', paths: [] }, {})
    expect(stage.person_handoff?.deliverables).toEqual({ kind: 'files', paths: [] })
    expect(stage.person_handoff?.note).toBe('Please read this.')
    expect(stage.person_handoff?.source_files).toBeUndefined()
  })

  it('attaches the transcript as a source file at its fixed target path', () => {
    const [stage] = stages({ kind: 'files', paths: [] }, { sourceTranscript: transcript })
    expect(stage.person_handoff?.deliverables).toEqual({ kind: 'transcript', include: true })
    expect(stage.person_handoff?.source_files).toEqual([
      { ...transcriptPin, target_path: CONVERSATION_TRANSCRIPT_TARGET_PATH }
    ])
  })

  it('appends one note line naming the file, message count and size', () => {
    const [stage] = stages({ kind: 'files', paths: [] }, { sourceTranscript: transcript })
    expect(stage.person_handoff?.note).toBe(
      'Please read this.\n\nTranscript attached: transcript-ses_abc123-20260913.md (12 messages, 4.0 KiB)'
    )
    expect(stage.brief).toContain('Transcript attached:')
  })

  it('produces a request the person-handoff schema accepts', () => {
    const [stage] = stages({ kind: 'files', paths: [] }, { sourceTranscript: transcript })
    expect(conversationPersonHandoffRequest.safeParse(stage.person_handoff).success).toBe(true)
  })

  it('refuses to silently drop work files the person also chose', () => {
    expect(() =>
      stages({ kind: 'files', paths: ['out/report.md'] }, { sourceTranscript: transcript })
    ).toThrow(/either the session transcript or selected work files/)
  })

  it('refuses when the note has no room left for the transcript line', () => {
    expect(() =>
      stages({ kind: 'files', paths: [] }, { sourceTranscript: transcript }, 'n'.repeat(8180))
    ).toThrow(/no room left for the transcript line/)
  })

  it('counts the transcript against the 32-file limit', () => {
    const files = Array.from({ length: 32 }, (_, index) => ({
      ...transcriptPin,
      target_path: `out/file-${index}.md`
    }))
    expect(() =>
      conversationFleetHandoffStages(step({ kind: 'files', paths: [] }), [], true, '/work/repo', {
        sourceTranscript: transcript,
        sourceDeliverableFiles: files
      })
    ).toThrow(/at most 32 files; the transcript counts as one/)
  })
})

describe('conversationTranscriptNoteLine', () => {
  it('scales the size unit to the file', () => {
    const line = (size_bytes: number) =>
      conversationTranscriptNoteLine({
        file: { ...transcriptPin, file: { ...transcriptPin.file, size_bytes } },
        messageCount: 1
      })
    expect(line(512)).toContain('(1 messages, 512 bytes)')
    expect(line(2048)).toContain('2.0 KiB')
    expect(line(3 * 1024 * 1024)).toContain('3.0 MiB')
  })
})

describe('the person handoff deliverables schema', () => {
  const base = {
    version: 1 as const,
    approved: true as const,
    recipient_employee_id: 'emp_uma',
    task_id: 'btk_abcdefgh',
    note: 'note',
    include_summary: false
  }

  it('accepts the transcript deliverable', () => {
    expect(
      conversationPersonHandoffRequest.safeParse({
        ...base,
        deliverables: { kind: 'transcript', include: true }
      }).success
    ).toBe(true)
  })

  it('refuses a transcript deliverable that records no consent', () => {
    expect(
      conversationPersonHandoffRequest.safeParse({
        ...base,
        deliverables: { kind: 'transcript', include: false }
      }).success
    ).toBe(false)
  })

  it('refuses unknown fields on the transcript deliverable', () => {
    expect(
      conversationPersonHandoffRequest.safeParse({
        ...base,
        deliverables: { kind: 'transcript', include: true, paths: ['x'] }
      }).success
    ).toBe(false)
  })

  it('still accepts the file and manifest deliverables', () => {
    for (const deliverables of [
      { kind: 'files', paths: ['out/a.md'] },
      { kind: 'manifest', manifestPath: 'out/manifest.json' },
      { kind: 'manifests', manifestPaths: ['out/a.json'] }
    ]) {
      expect(conversationPersonHandoffRequest.safeParse({ ...base, deliverables }).success).toBe(
        true
      )
    }
  })
})
