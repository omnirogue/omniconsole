import { localFallbackProblem } from './local-fallback-selection'
import { fleetFallbackProblem } from './fleet-fallback-selection'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { compileNextStepChain } from '../../../../shared/next-step-compile'
import {
  nextStepAgents,
  type NextStepDraft,
  type NextStepProblem
} from '../../../../shared/next-step-draft'
import { createNextStepSendMemory, sendNextStep } from './next-step-send'
import { nextStepDraftPolicyProblems } from '../../../../shared/next-step-policy'
import {
  sessionChainPolicyBlocks,
  type SessionChainSource
} from '../../../../shared/session-chain-policy'
import type { NextStepSubject } from './next-step-subject'
import type { NextStepRecipientSource } from './use-next-step-recipients'

/** Validate the dispatch draft before the external submit callback. */
function submissionProblems(draft: NextStepDraft, cardlessHandoffs: boolean): NextStepProblem[] {
  return compileNextStepChain({
    draft,
    cardlessHandoffs,
    chainId: 'chn_arm',
    workspacePath: '/',
    sessionLabel: 'session',
    defaultNote: 'note',
    now: 0,
    mintStepId: (position) => `step_${position}`,
    mintOperationId: () => 'op_armed_0000'
  }).problems
}

export function useNextStepSubmit({
  subject,
  draft,
  refreshAgents,
  fleet = false,
  fleetMachineId,
  cardlessHandoffs,
  policySource = null,
  onSubmit,
  onSent
}: {
  subject: NextStepSubject
  draft: NextStepDraft
  refreshAgents: NextStepRecipientSource['refreshAgents']
  fleet?: boolean
  fleetMachineId?: string
  cardlessHandoffs: boolean
  /** The session the plan runs after, for the review rules; null when unknown. */
  policySource?: SessionChainSource | null
  onSubmit?: (draft: NextStepDraft) => Promise<void>
  onSent?: () => void
}) {
  // A retry after a partial failure reuses hub keys and skips completed recipients.
  const memory = useRef(createNextStepSendMemory())
  const [problems, setProblems] = useState<NextStepProblem[]>([])
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const send = async (): Promise<void> => {
    setPending(true)
    setError('')
    try {
      const verifiedDraft = structuredClone(draft)
      const actors = [
        ...nextStepAgents(verifiedDraft),
        ...verifiedDraft.after.flatMap((step) => (step.kind === 'agent' ? [step.actor] : []))
      ]
      if (actors.length > 0) {
        const fresh = await refreshAgents()
        for (const actor of actors) {
          const available = fresh.find(
            (entry) => entry.id === actor.agent && entry.status === 'usable'
          )
          const routeProblem = fleet
            ? fleetFallbackProblem(actor, available?.models ?? [], fleetMachineId)
            : localFallbackProblem(actor, available?.models ?? [])
          if (routeProblem) {
            setError(routeProblem)
            return
          }
          if (
            !available ||
            !available.models.length ||
            (actor.model && !available.models.some((model) => model.id === actor.model)) ||
            actor.accountChoiceId
          ) {
            setError(
              translate(
                'conversations.agentBecameUnavailable',
                'This agent or model is no longer available. Refresh and choose another.'
              )
            )
            return
          }
          // Defaults must name a verified model; provider defaults may point to an exhausted model.
          actor.model ??= (
            available.models.find((model) => model.isDefault) ?? available.models[0]
          )?.id
          const selectedModel = available.models.find((model) => model.id === actor.model)
          const effortOption = selectedModel?.options.find((option) => option.id === 'effort')
          if (
            actor.effort &&
            (effortOption?.kind.type !== 'select' ||
              !effortOption.kind.choices.some((choice) => choice.value === actor.effort))
          ) {
            setError(
              translate(
                'conversations.effortUnavailable',
                'This model does not offer the selected effort. Choose another effort.'
              )
            )
            return
          }
        }
      }
      // Why: a plan that breaks a review rule is refused here, before anything launches.
      const [blocked] = sessionChainPolicyBlocks(
        nextStepDraftPolicyProblems(verifiedDraft, policySource, cardlessHandoffs)
      )
      if (blocked) {
        setError(blocked.message)
        return
      }
      if (onSubmit) {
        const found = submissionProblems(verifiedDraft, cardlessHandoffs)
        setProblems(found)
        if (found.length) {
          setError(translate('nextStep.incomplete', 'A few things still need choosing.'))
          return
        }
        await onSubmit(verifiedDraft)
        return
      }
      const result = await sendNextStep(subject, verifiedDraft, memory.current)
      if (result.ok) {
        toast.success(result.message)
        onSent?.()
      } else {
        setProblems(result.problems ?? [])
        setError(result.message)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }
  return { problems, setProblems, error, pending, send }
}
