import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { NextStepDraft } from '../../../../../shared/next-step-draft'
import { createNextStepSendMemory, sendNextStep } from '../next-step-send'
import type { NextStepSubject } from '../next-step-subject'
import type { useFleetDispatch } from '../use-fleet-dispatch'
import { dispatchToFleet, type FleetTarget } from './dispatch-to-fleet'

/** A refusal a person can act on: the console's sentence and the page that fixes it. */
export type SendAction = { label: string; href: string }

/**
 * The one Send behind the popover's button. A fleet target goes through prepare and
 * dispatch with the card resolved first; anything else takes the ordinary session chain.
 * Both report back in the popover: failures inline, a review warning as one line.
 */
export function useAddNextSend({
  subject,
  fleet,
  linkedTask,
  onSent
}: {
  subject: NextStepSubject
  fleet: ReturnType<typeof useFleetDispatch> | null
  linkedTask: { id: string; title: string } | null
  onSent: () => void
}) {
  const [error, setError] = useState('')
  const [action, setAction] = useState<SendAction | null>(null)
  const [pending, setPending] = useState(false)
  const [note, setNote] = useState('')
  const [done, setDone] = useState(false)
  const memory = useRef(createNextStepSendMemory())
  const toFleet = async (
    draft: NextStepDraft,
    target: FleetTarget,
    fanoutAcknowledged: boolean
  ): Promise<void> => {
    if (!fleet || subject.kind !== 'session') {
      setError(translate('nextStep.fleetUnavailableHere', 'The fleet is not available here.'))
      return
    }
    const result = await dispatchToFleet({
      session: subject.session,
      draft,
      linkedTask,
      target,
      fanoutAcknowledged,
      ports: fleet
    })
    if ('refusal' in result) {
      setError(result.refusal)
      if (result.actionUrl) {
        setAction({
          label: translate('nextStep.openInOmnios', 'Open in OmniOS'),
          href: result.actionUrl
        })
      }
      return
    }
    // Why: a warning is worth reading but never worth a dialog; the popover says it and
    // stops offering Dispatch, because the work is already on its way.
    if (result.warnings.length > 0) {
      setDone(true)
      setNote(result.warnings.join(' '))
      return
    }
    onSent()
  }
  const send = async (
    draft: NextStepDraft,
    target: FleetTarget | null,
    fanoutAcknowledged: boolean
  ): Promise<void> => {
    setPending(true)
    setError('')
    setAction(null)
    try {
      if (target) {
        await toFleet(draft, target, fanoutAcknowledged)
        return
      }
      const result = await sendNextStep(subject, draft, memory.current)
      if (result.ok) {
        toast.success(result.message)
        onSent()
      } else {
        setError(result.message)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }
  /** A new plan or a new target deserves a fresh answer; the old refusal is not it. */
  const clear = (): void => {
    setError('')
    setAction(null)
  }
  return { error, action, pending, note, done, send, clear }
}
