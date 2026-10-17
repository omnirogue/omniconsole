// Canonical English copy for the native-chat empty/loading/error states, shared
// by the desktop renderer (as its i18n fallback strings) and the mobile app
// (used directly — mobile ships English only) so the two surfaces never drift.
// `{{agent}}` is the agent label; each caller substitutes it (i18n on desktop,
// `formatNativeChatEmptyStateCopy` on mobile).

export type NativeChatEmptyStateCopy = { title: string; subtitle: string }

export const NATIVE_CHAT_EMPTY_STATE_COPY = {
  loading: {
    title: 'Loading conversation…',
    subtitle: 'Connecting to your conversation.'
  },
  empty: {
    title: 'Start work with {{agent}}',
    subtitle: 'Describe what you need, share files, or ask a question.'
  },
  error: {
    title: 'Could not load conversation',
    subtitle: 'Conversation history is temporarily unavailable. Try loading it again.'
  },
  notAgent: {
    title: 'No conversation here',
    subtitle: 'This terminal is not running a recognized coding agent.'
  }
} as const satisfies Record<string, NativeChatEmptyStateCopy>

/** Resolve the empty-state copy with the agent label substituted for `{{agent}}`.
 *  For platforms without an i18n layer (mobile). */
export function formatNativeChatEmptyStateCopy(
  kind: keyof typeof NATIVE_CHAT_EMPTY_STATE_COPY,
  agentLabel: string
): NativeChatEmptyStateCopy {
  const copy = NATIVE_CHAT_EMPTY_STATE_COPY[kind]
  return {
    title: copy.title.replaceAll('{{agent}}', agentLabel),
    subtitle: copy.subtitle.replaceAll('{{agent}}', agentLabel)
  }
}
