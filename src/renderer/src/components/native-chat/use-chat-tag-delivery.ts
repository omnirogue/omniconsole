import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { useHandoffPeople } from '@/components/next-step/use-handoff-people'
import { handoffApi } from '@/components/handoffs/handoff-client'
import {
  recoverPendingHandoff,
  readHandoffChatView,
  writeHandoffChatView,
  type HandoffChatView
} from '@/components/handoffs/handoff-request-memory'
import { workflowData } from '@/lib/console-workflow-client'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import { loadBackofficeWork } from '@/components/task-page/backoffice/backoffice-work-store'
import {
  chooseChatRecipient,
  chatSourceConversationId,
  type ChatRecipient,
  type ChatAttachment
} from '../../../../shared/chat-delivery'
import type { CommunicationType } from '../../../../shared/communication-type'
import type { ChatAgentRecipient } from '../../../../shared/console-chat-agent-contract'
import { sendChatDelivery, type ChatDeliveryReceipt } from './chat-delivery-send'

export function useChatTagDelivery({
  paneKey,
  draft,
  setDraft,
  setCaret,
  mentionQuery,
  onSent
}: {
  paneKey: string
  draft: string
  setDraft: (text: string) => void
  setCaret: (caret: number) => void
  mentionQuery: string | null
  onSent: () => void
}) {
  const scope = useHandoffScope()
  const target = `chat:${paneKey}`
  const [restored] = useState(() => recoverPendingHandoff(scope, target))
  const [savedView] = useState(() => {
    try {
      return { value: readHandoffChatView(scope, target), error: '' }
    } catch {
      return {
        value: { draft: null, sent: [] } as HandoffChatView,
        error: translate(
          'chatDelivery.recoveryFailed',
          'The saved chat recipients could not be recovered. Restore saved app data before sending.'
        )
      }
    }
  })
  const pendingDraft =
    restored.pending?.kind === 'chat' ? restored.pending.body.draft : savedView.value.draft
  const [recipients, setRecipients] = useState<ChatRecipient[]>(pendingDraft?.recipients ?? [])
  const [attachments, setAttachments] = useState<ChatAttachment[]>(pendingDraft?.attachments ?? [])
  const [type, setType] = useState<CommunicationType>(
    pendingDraft?.communicationType ?? 'information'
  )
  const [pending, setPending] = useState(false)
  const [retrySaved, setRetrySaved] = useState(restored.pending?.kind === 'chat')
  const [attaching, setAttaching] = useState(false)
  const [error, setError] = useState(restored.error || savedView.error)
  const [history, setHistory] = useState(savedView.value.sent)
  const [storageError, setStorageError] = useState(savedView.error)
  const [receipts, setReceipts] = useState<ChatDeliveryReceipt>({})
  const [sentTo, setSentTo] = useState<ChatRecipient[]>([])
  const [agents, setAgents] = useState<ChatAgentRecipient[]>([])
  const [agentError, setAgentError] = useState('')
  const [agentsLoaded, setAgentsLoaded] = useState(false)
  const agentsRequested = useRef(false)
  const busy = useRef(false)
  const live = useRef(true)
  const initialScope = useRef(scope)
  const directory = useHandoffPeople()
  const current = useCallback(
    () =>
      live.current && selectConsoleAccountScope(useAppStore.getState()) === initialScope.current,
    []
  )
  const draftRestored = useRef(false)

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  useEffect(() => {
    if (pendingDraft && !draftRestored.current) {
      draftRestored.current = true
      setDraft(pendingDraft.message)
      setCaret(pendingDraft.message.length)
    }
    // The composer remounts when its account/pane changes.
  }, [pendingDraft, setDraft, setCaret])
  const persistView = useEffectEvent(() => {
    if (!current() || savedView.error) {
      return
    }
    let persistenceError = ''
    try {
      writeHandoffChatView(scope, target, {
        draft: recipients.length
          ? { recipients, attachments, communicationType: type, message: draft }
          : null,
        sent: history
      })
    } catch (cause) {
      persistenceError = cause instanceof Error ? cause.message : String(cause)
    }
    setStorageError(persistenceError)
  })
  useEffect(() => {
    persistView()
  }, [scope, target, recipients, attachments, type, draft, history])
  useEffect(() => {
    if (mentionQuery === null || agentsRequested.current) {
      return
    }
    agentsRequested.current = true
    void Promise.resolve()
      .then(() => handoffApi().agentRecipients())
      .then((response) => {
        if (current()) {
          setAgents(workflowData(response).agents)
        }
      })
      .catch((cause) => {
        if (current()) {
          setAgentError(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        if (current()) {
          setAgentsLoaded(true)
        }
      })
  }, [mentionQuery, current])

  const attach = async (paths: string[], connectionId?: string) => {
    if (busy.current || !current()) {
      return
    }
    busy.current = true
    setAttaching(true)
    setError('')
    try {
      const captured: ChatAttachment[] = []
      for (const path of paths) {
        const file = workflowData(
          await handoffApi().readAttachment({
            filePath: path,
            ...(connectionId ? { connectionId } : {})
          })
        )
        if (!current()) {
          return
        }
        const { contentBase64: _bytes, ...metadata } = file
        captured.push({ path, ...(connectionId ? { connectionId } : {}), file: metadata })
      }
      setAttachments((previous) => {
        const next = [...previous]
        for (const value of captured) {
          const index = next.findIndex(
            (item) => item.path === value.path && item.connectionId === value.connectionId
          )
          if (index === -1) {
            next.push(value)
          } else {
            next[index] = value
          }
        }
        return next
      })
    } catch (cause) {
      if (current()) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      busy.current = false
      if (current()) {
        setAttaching(false)
      }
    }
  }

  const send = async () => {
    if (busy.current || storageError || restored.error || !recipients.length || !current()) {
      return
    }
    busy.current = true
    setPending(true)
    setError('')
    try {
      const result = await sendChatDelivery(
        scope,
        target,
        {
          sourceConversationId: await chatSourceConversationId(paneKey),
          sourceLabel: 'Chat',
          recipients,
          communicationType: type,
          message: draft,
          attachments
        },
        setReceipts
      )
      if (!current()) {
        return
      }
      setReceipts(result)
      setRetrySaved(false)
      setSentTo(recipients)
      setHistory((previous) => [...previous, { recipients, receipts: result }].slice(-20))
      setRecipients([])
      setAttachments([])
      setDraft('')
      setCaret(0)
      onSent()
      void loadBackofficeWork(scope, { force: true })
    } catch (cause) {
      if (current()) {
        const retained = recoverPendingHandoff(scope, target).pending
        if (retained?.kind === 'chat') {
          setRetrySaved(true)
          setRecipients(retained.body.draft.recipients)
          setAttachments(retained.body.draft.attachments)
          setType(retained.body.draft.communicationType)
          setDraft(retained.body.draft.message)
        }
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      busy.current = false
      if (current()) {
        setPending(false)
      }
    }
  }
  return {
    scope,
    recipients,
    attachments,
    type,
    setType,
    pending,
    attaching,
    error: storageError || error,
    receipts,
    sentTo,
    history,
    retrySaved,
    blocked: !!(storageError || restored.error),
    people: directory.people,
    agents,
    agentError,
    agentsLoaded,
    viewer: directory.employeeId,
    choose: (recipient: ChatRecipient) => {
      setRecipients((previous) => chooseChatRecipient(previous, recipient))
      setError('')
    },
    remove: (id: string, kind: ChatRecipient['kind']) =>
      setRecipients((previous) => previous.filter((item) => item.id !== id || item.kind !== kind)),
    removeAttachment: (path: string) =>
      setAttachments((previous) => previous.filter((item) => item.path !== path)),
    attach,
    send
  }
}
