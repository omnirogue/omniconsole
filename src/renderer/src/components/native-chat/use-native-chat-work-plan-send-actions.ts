export type NativeChatWorkPlanSendDeps = {
  tags: { blocked: boolean; tagging: boolean; active: boolean; send: () => unknown }
  disabled: boolean
  isWorking: boolean
  hasImageAttachments: boolean
  draft: string
  /** #364's `/next …`/`/queue …` reader: a true answer means the line was queued, not sent. */
  queuePrompt: (text: string) => boolean
  /** True when session prep took the line instead of sending it to this conversation. */
  prepareSessions: (text: string) => boolean
  classifySend: (text: string) => string
  deliver: (text: string, historyText?: string) => boolean | Promise<boolean>
  engineerSend: (
    text: string,
    deliverDraft: (text: string) => boolean | Promise<boolean>,
    focusAfter?: boolean
  ) => unknown
  deliverDraft: (text: string) => boolean | Promise<boolean>
}

/** Ordinary chat goes to the provider; only explicit /next commands schedule work. */
export function useNativeChatWorkPlanSendActions(deps: NativeChatWorkPlanSendDeps): {
  send: () => void
  sendNow: () => void
  go: () => void
  engineerDisabled: boolean
} {
  const {
    tags,
    disabled,
    isWorking,
    hasImageAttachments,
    draft,
    queuePrompt,
    prepareSessions,
    classifySend,
    deliver,
    engineerSend,
    deliverDraft
  } = deps
  const nativeSend = (text: string): unknown => {
    if (tags.blocked || tags.tagging) {
      return undefined
    }
    if (tags.active) {
      return tags.send()
    }
    if (disabled || (text.trim() === '' && !hasImageAttachments)) {
      return undefined
    }
    if (classifySend(text) !== 'chat') {
      return deliver(text)
    }
    return engineerSend(text, deliverDraft)
  }
  const submit = () => {
    if (tags.blocked || tags.tagging) {
      return
    }
    if (tags.active) {
      void tags.send()
      return
    }
    if (queuePrompt(draft)) {
      return
    }
    if (prepareSessions(draft)) {
      return
    }
    void nativeSend(draft)
  }
  const send = submit
  const sendNow = submit
  const engineerDisabled = disabled || isWorking || tags.active || tags.tagging
  const go = () => {
    if (engineerDisabled) {
      return
    }
    void engineerSend(draft, deliverDraft, true)
  }
  return { send, sendNow, go, engineerDisabled }
}
