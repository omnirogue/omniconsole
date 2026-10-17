import type { NextStepDraft } from '../../../../shared/next-step-draft'
import { sessionFollowUpTranscriptSource } from '../../../../shared/session-follow-up-transcript'
import type { NextStepSubject } from './next-step-subject'
import { transcriptSourceForSubject } from './use-transcript-preview'
import { chatSourceConversationId } from '../../../../shared/chat-delivery'

/** Saving consent records identity only. Capture is deferred to the verified completion. */
export async function withQueuedTranscriptSource(
  subject: NextStepSubject,
  draft: NextStepDraft
): Promise<NextStepDraft> {
  if (subject.kind === 'session' && subject.session.paneKey) {
    draft = {
      ...draft,
      handoff: {
        ...draft.handoff,
        sourceConversationId:
          draft.handoff.sourceConversationId ??
          (await chatSourceConversationId(subject.session.paneKey))
      }
    }
  }
  if (!draft.handoff.includeTranscript) {
    return draft
  }
  const source = sessionFollowUpTranscriptSource.safeParse(transcriptSourceForSubject(subject))
  if (!source.success) {
    throw new Error(
      'The session history source cannot be verified. Reopen this session before saving its history handoff.'
    )
  }
  return { ...draft, handoff: { ...draft.handoff, transcriptSource: source.data } }
}
