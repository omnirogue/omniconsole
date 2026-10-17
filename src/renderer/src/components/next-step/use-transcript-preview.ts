import { useEffect, useState } from 'react'
import { resolveSidebarSource } from '@/lib/conversation-fleet-context-source'
import {
  readConversationFleetTranscript,
  type ConversationFleetTranscriptSource
} from '@/lib/conversation-fleet-transcript-reader'
import type { NextStepSubject } from './next-step-subject'

export type TranscriptPreviewState = {
  /** The subject is a session whose transcript could be sent. */
  offered: boolean
  preview: { messageCount: number; sizeBytes: number } | null
  /** The host's refusal, or why the transcript could not be built. */
  error: string | null
  pending: boolean
}

const IDLE: TranscriptPreviewState = {
  offered: false,
  preview: null,
  error: null,
  pending: false
}

/** Only a live session has a transcript; a card or a thread has none. */
export function transcriptSourceForSubject(
  subject: NextStepSubject
): ConversationFleetTranscriptSource | null {
  if (subject.kind !== 'session') {
    return null
  }
  try {
    const source = resolveSidebarSource(subject.session)
    return {
      kind: source.sourceKind,
      hostId: source.sourceHostId,
      agent: source.sourceAgent,
      sessionId: source.sourceSessionId,
      ...(source.sourceRuntimeEnvironmentId
        ? { runtimeEnvironmentId: source.sourceRuntimeEnvironmentId }
        : {}),
      ...(source.sourceTranscriptPath ? { transcriptPath: source.sourceTranscriptPath } : {})
    }
  } catch {
    // A session whose identity is not settled yet simply offers no transcript.
    return null
  }
}

/**
 * Build the transcript as soon as it is ticked, so its size — or the redactor's
 * refusal — is on screen before anyone presses Send, not after.
 */
export function useTranscriptPreview(
  subject: NextStepSubject,
  included: boolean
): TranscriptPreviewState {
  const [state, setState] = useState<TranscriptPreviewState>(IDLE)
  const source = transcriptSourceForSubject(subject)
  const key = source ? JSON.stringify(source) : null
  useEffect(() => {
    if (!key || !source || !included) {
      setState({ ...IDLE, offered: Boolean(key) })
      return
    }
    const controller = new AbortController()
    let live = true
    setState({ offered: true, preview: null, error: null, pending: true })
    readConversationFleetTranscript(source, new Date().toISOString(), controller.signal, true)
      .then((result) => {
        if (!live) {
          return
        }
        setState(
          result.kind === 'refused'
            ? { offered: true, preview: null, error: result.message, pending: false }
            : {
                offered: true,
                preview: {
                  messageCount: result.messageCount,
                  sizeBytes: result.file.size
                },
                error: null,
                pending: false
              }
        )
      })
      .catch((error: unknown) => {
        if (!live || controller.signal.aborted) {
          return
        }
        setState({
          offered: true,
          preview: null,
          error: error instanceof Error ? error.message : 'The transcript could not be built.',
          pending: false
        })
      })
    return () => {
      live = false
      controller.abort()
    }
    // The source object is rebuilt each render; its identity is the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, included])
  return state
}
