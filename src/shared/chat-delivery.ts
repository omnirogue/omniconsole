import { z } from 'zod'
import { communicationType } from './communication-type'
import { exactHandoffFile, HANDOFF_FILE_MAX_BYTES } from './console-handoff-contract'

const identity = z.string().min(1).max(512)
export const chatRecipient = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('person'),
    id: z.string().regex(/^emp_[A-Za-z0-9_-]+$/),
    name: identity
  }),
  z.object({
    kind: z.literal('agent'),
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    name: identity,
    employeeId: identity,
    projectId: identity
  })
])
export type ChatRecipient = z.infer<typeof chatRecipient>

export const chatAttachment = z.object({
  path: z.string().min(1).max(4096),
  connectionId: z.string().min(1).max(512).optional(),
  file: exactHandoffFile.omit({ contentBase64: true })
})
export type ChatAttachment = z.infer<typeof chatAttachment>

export const chatDeliveryDraft = z
  .object({
    sourceConversationId: identity,
    sourceLabel: z.string().min(1).max(500),
    recipients: z.array(chatRecipient).min(1).max(20),
    communicationType,
    message: z.string().max(8192),
    attachments: z.array(chatAttachment).max(32)
  })
  .superRefine((draft, ctx) => {
    if (
      draft.recipients.some((recipient) => recipient.kind === 'agent') &&
      new TextEncoder().encode(chatDeliveryMessage(draft)).length > 8192
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Agent messages can contain up to 8 KB of text. Attach a file for longer content.'
      })
    }
    if (
      draft.attachments.reduce((size, { file }) => size + file.size, 0) > HANDOFF_FILE_MAX_BYTES
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Attach up to 10 MB per message, or send a link to larger files.'
      })
    }
    if (!draft.message.trim() && !draft.attachments.length) {
      ctx.addIssue({ code: 'custom', message: 'Write a message or attach a file.' })
    }
    const names = draft.attachments.map(({ file }) => file.name)
    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Attachments need distinct names. Attach their folder to preserve matching names.'
      })
    }
    const recipients = draft.recipients.map(chatRecipientKey)
    if (new Set(recipients).size !== recipients.length) {
      ctx.addIssue({ code: 'custom', message: 'Each recipient can be tagged once.' })
    }
  })
export type ChatDeliveryDraft = z.infer<typeof chatDeliveryDraft>

export function chatRecipientKey(recipient: ChatRecipient): string {
  return `${recipient.kind}:${recipient.id}`
}

/** A name in prose never becomes an address; only a chosen directory entry does. */
export function chooseChatRecipient(
  current: readonly ChatRecipient[],
  recipient: ChatRecipient
): ChatRecipient[] {
  const selected = chatRecipient.parse(recipient)
  return current.some((entry) => chatRecipientKey(entry) === chatRecipientKey(selected))
    ? [...current]
    : [...current, selected]
}

export function chatDeliveryTitle(
  draft: Pick<ChatDeliveryDraft, 'message' | 'attachments' | 'sourceLabel'>
): string {
  return (
    (
      draft.message
        .trim()
        .split('\n')
        .find((line) => line.trim()) ?? draft.attachments.map(({ file }) => file.name).join(', ')
    ).slice(0, 160) || draft.sourceLabel.slice(0, 160)
  )
}

export function chatDeliveryMessage(
  draft: Pick<ChatDeliveryDraft, 'message' | 'attachments'>
): string {
  return draft.message.trim() || draft.attachments.map(({ file }) => file.name).join(', ')
}

export async function chatSourceConversationId(paneKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(paneKey))
  return `chat_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
