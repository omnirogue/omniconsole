import { useCallback, useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useSessionChainForRow, setSessionChainEntry } from '@/lib/session-chain-registry'
import { buildCompiledSessionChain } from '@/lib/session-chain-build'
import { commitWorkPlan } from '../../../../../shared/work-plan-commit'
import { listAgentAccountChoices } from '../../../../../shared/agent-account-profiles'
import type { WorkPlanContext, WorkPlanRole } from '../../../../../shared/work-plan-types'
import type { NextStepSubject } from '../next-step-subject'
import type { useNextStepRecipients } from '../use-next-step-recipients'
import { commitSessionOutcomes, getOutcomeCapabilities } from '../next-step-outcome-client'
import { anchorWorkPlan } from './work-plan-state-from-chain'
import { WorkPlanQuestions } from './WorkPlanQuestions'

export function LiveWorkPlanQuestions({
  subject,
  data,
  onSent,
  initialPerson,
  onWhere
}: {
  subject: Extract<NextStepSubject, { kind: 'session' }>
  data: ReturnType<typeof useNextStepRecipients>
  onSent: () => void
  initialPerson?: boolean
  onWhere: (
    kind: 'agent' | 'person' | 'fleet' | null,
    action?: WorkPlanRole,
    instruction?: string
  ) => void
}) {
  const chain = useSessionChainForRow(subject.session.rowKey)
  const settings = useAppStore((state) => state.settings)
  const sourceModel = useAppStore((state) =>
    subject.session.paneKey
      ? state.agentStatusByPaneKey?.[subject.session.paneKey]?.model
      : undefined
  )
  const [chainId] = useState(() => crypto.randomUUID())
  /**
   * The same-conversation route is the HOST's to advertise: it delivers the turn and settles it.
   * Asked LAZILY, and never on the bare ＋ open or the New prompt path — queuing the next prompt is
   * ordinary conversation and touches no plan machinery. The probe runs when a plan already exists,
   * when the person answers a plan question, and once more (awaited) before a plan is committed, so
   * the commit always carries the host's real answer. Until it answers the route reads false, which
   * refuses it with plain words.
   */
  const [sameConversationRoute, setSameConversationRoute] = useState(false)
  const probed = useRef<{ owner: string; answer: Promise<boolean> } | null>(null)
  const probeSameConversationRoute = useCallback((): Promise<boolean> => {
    const owner = String(chain?.placement ?? chain?.hostId ?? subject.session.hostId ?? '')
    if (probed.current?.owner !== owner) {
      probed.current = {
        owner,
        answer: getOutcomeCapabilities(chain ?? subject.session)
          .then((value) => value.sameConversationRoute === true)
          // A host that cannot be asked has not claimed the route.
          .catch(() => false)
      }
    }
    return probed.current.answer.then((answer) => {
      setSameConversationRoute(answer)
      return answer
    })
  }, [chain, subject.session])
  useEffect(() => {
    // A committed plan is already plan machinery; asking about its host costs the person nothing.
    if (chain?.outcomeSet) {
      void probeSameConversationRoute()
    }
  }, [chain?.outcomeSet, probeSameConversationRoute])
  const agents = data.agents.phase === 'ready' ? data.agents.value : []
  const ctx: WorkPlanContext = {
    usableAgents: agents.map((agent) => ({
      agent: agent.id,
      models: (agent.models ?? []).map((model) => ({
        id: model.id,
        label: model.label,
        efforts: (model.options ?? []).flatMap((option) =>
          option.id === 'effort' && option.kind.type === 'select'
            ? option.kind.choices.map((choice) => choice.value)
            : []
        )
      }))
    })),
    source: { agent: subject.session.agent, model: sourceModel },
    placement:
      chain?.outcomeSet?.continuation.taskId || chain?.outcomeSet?.continuation.nativeSource
        ? 'card'
        : 'local',
    accountCatalogue:
      subject.session.hostId === 'local'
        ? agents.flatMap((agent) => listAgentAccountChoices(settings, agent.id))
        : [],
    commitSource: 'user',
    capabilities: { sameConversationRoute }
  }
  try {
    anchorWorkPlan(chain, subject)
  } catch (error) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {error instanceof Error ? error.message : String(error)}
      </p>
    )
  }
  return (
    <WorkPlanQuestions
      key={`${chain?.id ?? chainId}:${chain?.planVersion ?? 1}:${chain?.outcomeSet?.revision ?? 0}:${chain?.outcomeSet?.outcomes[0]?.status ?? 'draft'}`}
      initialPerson={initialPerson}
      chain={chain}
      subject={subject}
      ctx={ctx}
      data={data}
      onWhere={(next, action, instruction) => {
        // The person is answering the plan's questions now, so the host may be asked.
        void probeSameConversationRoute()
        onWhere(next, action, instruction)
      }}
      onSend={async (plan, changeStrategy) => {
        const base =
          chain ??
          buildCompiledSessionChain({
            session: subject.session,
            chainId,
            steps: [],
            auto: true,
            end: 'done'
          })
        if (!base) {
          return {
            problems: [
              {
                code: 'work-plan-owner',
                severity: 'block',
                message: translate(
                  'nextStep.executionWorkspaceUnavailable',
                  'The execution workspace is unavailable.'
                )
              }
            ]
          }
        }
        const result = await commitWorkPlan(plan, {
          ...ctx,
          // The one reading that decides a refusal is taken here, not from whatever the render
          // happened to hold: a plan is committed against the host's actual answer.
          capabilities: { sameConversationRoute: await probeSameConversationRoute() },
          chain: base,
          ...(changeStrategy ? { existingChain: chain! } : {}),
          commitSessionOutcomes: async (request) => {
            const committed = await commitSessionOutcomes(request)
            setSessionChainEntry(committed)
            return committed
          }
        })
        if ('chainId' in result) {
          onSent()
        }
        return result
      }}
    />
  )
}
