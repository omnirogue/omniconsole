import { handoffApi } from '@/components/handoffs/handoff-client'
import { companiesApi } from '@/components/companies/companies-client'
import {
  clearPendingHandoff,
  readPendingHandoff,
  retainPendingHandoff,
  updatePendingChatHandoff,
  readHandoffChatView,
  writeHandoffChatView,
  type PendingHandoffRequest
} from '@/components/handoffs/handoff-request-memory'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { workflowData } from '@/lib/console-workflow-client'
import { createFollowUpHubIo } from '@/lib/session-follow-up-io'
import { useAppStore } from '@/store'
import {
  chatDeliveryDraft,
  chatDeliveryMessage,
  chatDeliveryTitle,
  chatRecipientKey,
  type ChatDeliveryDraft
} from '../../../../shared/chat-delivery'
import { sendCardlessWithFiles } from '../../../../shared/session-follow-up-cardless-delivery'
import type { ExactHandoffFile } from '../../../../shared/console-handoff-contract'

export type ChatDeliveryReceipt = Extract<
  PendingHandoffRequest,
  { kind: 'chat' }
>['body']['receipts']

/** Uses the handoff outbox's saved request and keys; a retry cannot change who or what was sent. */
export async function sendChatDelivery(
  scope: string,
  target: string,
  input: ChatDeliveryDraft,
  onProgress?: (receipts: ChatDeliveryReceipt) => void
): Promise<ChatDeliveryReceipt> {
  const current = () => selectConsoleAccountScope(useAppStore.getState()) === scope
  const assertCurrent = () => {
    if (!current()) {
      throw new Error('The signed-in account changed. Reopen this message before sending.')
    }
  }
  assertCurrent()
  const draft = chatDeliveryDraft.parse(input)
  const existing = readPendingHandoff(scope, target)
  if (
    existing &&
    (existing.kind !== 'chat' || JSON.stringify(existing.body.draft) !== JSON.stringify(draft))
  ) {
    throw new Error('Retry the original message before changing its recipients or attachments.')
  }
  const [me, queue, people] = await Promise.all([
    companiesApi().me(),
    handoffApi().list({ view: 'sent' }),
    handoffApi().recipients()
  ])
  assertCurrent()
  const profile = workflowData(me)
  const employee = profile.ok !== false ? profile.user?.employee_id : null
  if (!employee || workflowData(queue).assignee !== employee) {
    throw new Error(
      'Your sign-in and handoff account do not match. The server identity must be corrected before sending.'
    )
  }
  const directory = workflowData(people).employees
  for (const recipient of draft.recipients) {
    if (recipient.kind === 'person' && !directory.some((person) => person.id === recipient.id)) {
      throw new Error(
        `${recipient.name} is no longer in your employee directory. Refresh the recipient.`
      )
    }
  }
  const files: ExactHandoffFile[] = []
  for (const attachment of draft.attachments) {
    assertCurrent()
    const file = workflowData(
      await handoffApi().readAttachment({
        filePath: attachment.path,
        ...(attachment.connectionId ? { connectionId: attachment.connectionId } : {})
      })
    )
    if (
      file.sha256 !== attachment.file.sha256 ||
      file.size !== attachment.file.size ||
      file.name !== attachment.file.name
    ) {
      throw new Error(
        `${attachment.file.name} changed after it was attached. The selected version has not been sent.`
      )
    }
    files.push(file)
  }
  const saved =
    existing?.kind === 'chat'
      ? existing
      : (retainPendingHandoff(scope, target, {
          kind: 'chat',
          body: {
            operationId: `chat_${crypto.randomUUID().replaceAll('-', '')}`,
            draft,
            receipts: {}
          }
        }) as Extract<PendingHandoffRequest, { kind: 'chat' }>)
  const receipts = { ...saved.body.receipts }
  const hub = createFollowUpHubIo()
  for (const [index, recipient] of draft.recipients.entries()) {
    assertCurrent()
    const key = chatRecipientKey(recipient)
    if (receipts[key]) {
      continue
    }
    const operationId = `${saved.body.operationId}_${index}`
    const id =
      recipient.kind === 'agent'
        ? workflowData(
            await handoffApi().sendAgent({
              recipientSessionId: recipient.id,
              sourceConversationId: draft.sourceConversationId,
              sourceLabel: draft.sourceLabel,
              message: chatDeliveryMessage(draft),
              communicationType: draft.communicationType,
              attachments: files,
              operationId
            })
          ).messageId
        : (
            await sendCardlessWithFiles(
              { hub, current },
              {
                title: chatDeliveryTitle(draft),
                recipient: recipient.id,
                note: chatDeliveryMessage(draft),
                communicationType: draft.communicationType,
                ...(draft.communicationType === 'decision' ? { action: 'decide' as const } : {}),
                operationId
              },
              files
            )
          ).thread_id
    if (!id) {
      throw new Error(
        `Delivery to ${recipient.name} is unconfirmed. Retry to check the same request.`
      )
    }
    receipts[key] = { id, kind: recipient.kind }
    updatePendingChatHandoff(scope, target, { ...saved, body: { ...saved.body, receipts } })
    if (current()) {
      onProgress?.(receipts)
    }
  }
  assertCurrent()
  const view = readHandoffChatView(scope, target)
  const sameReceipts = (sent: (typeof view.sent)[number]) =>
    JSON.stringify(sent.receipts) === JSON.stringify(receipts)
  writeHandoffChatView(scope, target, {
    draft: null,
    sent: view.sent.some(sameReceipts)
      ? view.sent
      : [...view.sent, { recipients: draft.recipients, receipts }].slice(-20)
  })
  clearPendingHandoff(scope, target, saved.body.operationId)
  return receipts
}
