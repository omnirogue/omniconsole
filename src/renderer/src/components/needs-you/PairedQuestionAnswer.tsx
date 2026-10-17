import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import {
  SESSION_QUESTION_OWNER_ANSWER_CAPABILITY,
  SESSION_QUESTION_OWNER_RPC,
  SessionQuestionOwnerReadResultSchema,
  SessionQuestionOwnerAnswerResultSchema,
  type SessionQuestionOwnerReady,
  type SessionQuestionOwnerRefusal,
  type SessionQuestionOwnerAnswerParams
} from '../../../../shared/session-question-owner-answer'
import type { AskAnswerSelection } from '../native-chat/native-chat-interactive-prompt'
import { NativeChatQuestionCard } from '../native-chat/NativeChatQuestionCard'
import { capturePairedQuestionOwner, isPairedQuestionOwnerCurrent } from './paired-question-owner'

type View = { key: string; message?: string; ready?: SessionQuestionOwnerReady; sending?: boolean }

function unavailable(): string {
  return translate(
    'needsYou.ownerQuestionUnavailable',
    'Can’t verify this question with its computer. Open the session to answer.'
  )
}

function stale(): string {
  return translate(
    'needsYou.ownerQuestionChanged',
    'The question or its session changed. Open the session to check it.'
  )
}

function refusalMessage(code: SessionQuestionOwnerRefusal['code']): string {
  return code === 'stale-question'
    ? translate(
        'needsYou.ownerQuestionUnverified',
        'The question could not be verified. Open the session to check it. Nothing was sent.'
      )
    : translate(
        'needsYou.ownerQuestionOpen',
        'Answer this question in its own session. Nothing was sent.'
      )
}

/** Only the execution owner can turn a mirrored question into an actionable card. */
export function PairedQuestionAnswer({
  paneKey,
  summary
}: {
  paneKey: string
  summary: string
}): React.JSX.Element {
  const ownerKey = useAppStore((state) =>
    JSON.stringify(capturePairedQuestionOwner(state, paneKey))
  )
  const owner = useMemo(() => {
    const current = capturePairedQuestionOwner(useAppStore.getState(), paneKey)
    return JSON.stringify(current) === ownerKey ? current : null
  }, [paneKey, ownerKey])
  const capability = useAppStore(
    (state) =>
      owner !== null &&
      state.runtimeStatusByEnvironmentId
        ?.get(owner.environmentId)
        ?.status?.capabilities?.includes(SESSION_QUESTION_OWNER_ANSWER_CAPABILITY) === true
  )
  const [view, setView] = useState<View>({ key: ownerKey })
  const controller = useRef<AbortController | null>(null)
  const sending = useRef(false)

  useEffect(() => {
    const abort = new AbortController()
    controller.current = abort
    sending.current = false
    if (!owner || !capability) {
      setView({
        key: ownerKey,
        message: !owner
          ? unavailable()
          : translate(
              'needsYou.ownerQuestionUpdate',
              'Update this session’s computer to answer here. You can still open the session.'
            )
      })
      return () => abort.abort()
    }
    setView({ key: ownerKey })
    void callRuntimeRpc(
      { kind: 'environment', environmentId: owner.environmentId },
      SESSION_QUESTION_OWNER_RPC.read,
      { runtimeId: owner.runtimeId, target: owner.target, displayed: owner.displayed },
      {
        signal: abort.signal,
        timeoutMs: 10_000,
        expectedEnvironmentPairingRevision: owner.pairingRevision
      }
    )
      .then((raw) => {
        if (abort.signal.aborted) {
          return
        }
        const parsed = SessionQuestionOwnerReadResultSchema.safeParse(raw)
        if (
          !isPairedQuestionOwnerCurrent(useAppStore.getState(), paneKey, owner) ||
          !parsed.success ||
          parsed.data.runtimeId !== owner.runtimeId ||
          JSON.stringify(parsed.data.target) !== JSON.stringify(owner.target)
        ) {
          setView({ key: ownerKey, message: stale() })
        } else if (parsed.data.status === 'refused') {
          setView({ key: ownerKey, message: refusalMessage(parsed.data.code) })
        } else {
          setView({ key: ownerKey, ready: parsed.data })
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setView({ key: ownerKey, message: unavailable() })
        }
      })
    return () => abort.abort()
  }, [owner, ownerKey, paneKey, capability])

  const ready = view.key === ownerKey ? view.ready : undefined
  const answer = async (selections: AskAnswerSelection[]): Promise<void> => {
    const abort = controller.current
    if (!owner || !ready || !abort || abort.signal.aborted || sending.current) {
      return
    }
    if (!isPairedQuestionOwnerCurrent(useAppStore.getState(), paneKey, owner)) {
      setView({ key: ownerKey, message: stale() })
      return
    }
    const selection = selections.length === 1 ? selections[0] : undefined
    const option =
      selection?.indices.length === 1 ? ready.question.options[selection.indices[0]!] : undefined
    const chosen: SessionQuestionOwnerAnswerParams['answer'] | null =
      option && !selection?.other
        ? { kind: 'choose', choice: option.n }
        : ready.question.acceptsText && selection?.indices.length === 0 && selection.other?.trim()
          ? { kind: 'text', text: selection.other.trim() }
          : null
    if (!chosen) {
      return
    }
    sending.current = true
    setView({ key: ownerKey, ready, sending: true })
    try {
      const raw = await callRuntimeRpc(
        { kind: 'environment', environmentId: owner.environmentId },
        SESSION_QUESTION_OWNER_RPC.answer,
        {
          runtimeId: owner.runtimeId,
          target: owner.target,
          displayed: owner.displayed,
          binding: ready.binding,
          answer: chosen
        },
        {
          signal: abort.signal,
          timeoutMs: 30_000,
          expectedEnvironmentPairingRevision: owner.pairingRevision
        }
      )
      if (
        abort.signal.aborted ||
        !isPairedQuestionOwnerCurrent(useAppStore.getState(), paneKey, owner)
      ) {
        return
      }
      const parsed = SessionQuestionOwnerAnswerResultSchema.safeParse(raw)
      if (
        !parsed.success ||
        parsed.data.runtimeId !== owner.runtimeId ||
        JSON.stringify(parsed.data.target) !== JSON.stringify(owner.target) ||
        (parsed.data.status === 'answered' &&
          JSON.stringify(parsed.data.binding) !== JSON.stringify(ready.binding))
      ) {
        throw new Error('Unverified answer receipt')
      }
      const result = parsed.data
      setView({
        key: ownerKey,
        message:
          result.status === 'refused'
            ? refusalMessage(result.code)
            : result.delivery === 'confirmed'
              ? translate('needsYou.ownerAnswerSent', 'Answer sent.')
              : translate(
                  'needsYou.ownerAnswerUnconfirmed',
                  'The answer was received, but delivery isn’t confirmed. Open the session to check before answering again.'
                )
      })
    } catch {
      if (!abort.signal.aborted) {
        setView({
          key: ownerKey,
          message: translate(
            'needsYou.ownerAnswerUnknown',
            'Couldn’t confirm delivery. Open the session to check before answering again.'
          )
        })
      }
    }
    // A refusal or uncertain receipt never acquires a new binding and retries the answer.
  }

  if (ready) {
    return (
      <NativeChatQuestionCard
        key={ready.binding.ownerFingerprint}
        prompt={{
          questions: [
            {
              question: ready.question.text,
              multiSelect: false,
              options: ready.question.options.map((option) => ({ label: option.label }))
            }
          ]
        }}
        allowOther={ready.question.acceptsText}
        isSubmitting={view.sending}
        onAnswer={(selections) => {
          void answer(selections)
        }}
        onCancel={() => {
          if (!sending.current) {
            setView({ key: ownerKey, message: unavailable() })
          }
        }}
      />
    )
  }
  return (
    <div data-needs-you-owner-question="">
      <div className="text-sm">{summary}</div>
      <p role="status" className="text-xs text-muted-foreground">
        {view.key === ownerKey && view.message
          ? view.message
          : translate('needsYou.ownerQuestionChecking', 'Checking the question with its computer…')}
      </p>
    </div>
  )
}
