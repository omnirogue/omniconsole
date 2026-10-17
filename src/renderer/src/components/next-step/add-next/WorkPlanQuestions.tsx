import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { commitWorkPlan } from '../../../../../shared/work-plan-commit'
import {
  recommendNextTransforms,
  type WorkPlanRecommendation
} from '../../../../../shared/work-plan-recommend'
import { workPlanNotation, workPlanSummary } from '../../../../../shared/work-plan-notation'
import { workPlanShapeActors, type WorkPlanShape } from '../../../../../shared/work-plan-shapes'
import {
  WORK_PLAN_ROLES,
  type WorkPlan,
  type WorkPlanContext,
  type WorkPlanRole
} from '../../../../../shared/work-plan-types'
import { SESSION_ACTION_PRESET_LABELS } from '../../../../../shared/session-action-presets'
import type { SessionChain } from '../../../../../shared/session-chain-types'
import type { NextStepSubject } from '../next-step-subject'
import type { NextStepRecipient } from '../../../../../shared/next-step-draft'
import type { useNextStepRecipients } from '../use-next-step-recipients'
import { WorkPlanRouting } from './WorkPlanRouting'
import { MenuRecipients } from './MenuRecipients'
import { MenuItem } from './MenuItems'
import { anchorWorkPlan, workPlanStateFromChain } from './work-plan-state-from-chain'
import { proposeNextWorkPlan } from './propose-next-work-plan'

type Choice = { id: string; label: string; action: WorkPlanRole; instruction: string }
const roleFor = (id: WorkPlanRecommendation['id']): WorkPlanRole =>
  WORK_PLAN_ROLES.find((role) => role === id) ??
  (id === 'done' || id === 'ask-me' ? 'summarize' : 'plan')
const human = (choice: Choice) =>
  ['verify', 'review', 'judge', 'summarize'].includes(choice.action) || choice.id === 'ask-me'

export function WorkPlanQuestions({
  chain,
  subject,
  ctx,
  data,
  onSend,
  initialPerson,
  onWhere
}: {
  chain: SessionChain | null
  subject: NextStepSubject
  ctx: WorkPlanContext
  data?: ReturnType<typeof useNextStepRecipients>
  initialPerson?: boolean
  onSend: (
    plan: WorkPlan,
    changeStrategy: boolean
  ) => Promise<Awaited<ReturnType<typeof commitWorkPlan>>>
  onWhere: (
    kind: 'agent' | 'person' | 'fleet' | null,
    action?: WorkPlanRole,
    instruction?: string
  ) => void
}) {
  const anchor = anchorWorkPlan(chain, subject)
  const recommendations = chain?.outcomeSet
    ? recommendNextTransforms(workPlanStateFromChain(chain, anchor.plan), anchor.plan.outcome)
    : []
  const recommended: Choice[] = recommendations.map((row) => ({ ...row, action: roleFor(row.id) }))
  // A blocked outcome opens its amendment even when it still needs Done When.
  recommended.sort(
    (a, b) => Number(b.id === 'change-strategy') - Number(a.id === 'change-strategy')
  )
  const choices: Choice[] = [
    ...recommended,
    ...WORK_PLAN_ROLES.filter((role) => !recommended.some((row) => row.id === role)).map(
      (role) => ({
        id: role,
        label: SESSION_ACTION_PRESET_LABELS[role],
        action: role,
        instruction: ''
      })
    )
  ]
  const [selected, setSelected] = useState<string | null>(null)
  const [topology, setTopology] = useState<WorkPlanShape>('solo')
  const [where, setWhere] = useState<'human' | 'new-session' | null>(null)
  const [instruction, setInstruction] = useState<string | null>(null)
  const [agentOpen, setAgentOpen] = useState(false)
  const [recipient, setRecipient] = useState<NextStepRecipient | null>(null)
  const [destination, setDestination] = useState<'agent' | 'person' | 'fleet' | null>(
    initialPerson ? 'person' : null
  )
  const [external, setExternal] = useState(initialPerson ?? false)
  const [pending, setPending] = useState(false)
  const sending = useRef(false)
  const [error, setError] = useState('')
  const actors = workPlanShapeActors(ctx)
  const propose = (
    choice: Choice,
    shape = topology,
    route = where ?? (human(choice) ? 'human' : 'new-session')
  ) => {
    const text = choice.id === selected ? (instruction ?? choice.instruction) : choice.instruction
    const candidates =
      recipient?.kind === 'agent'
        ? actors.filter((actor) => actor.agent === recipient.agent)
        : actors
    const results = candidates.map((actor) =>
      proposeNextWorkPlan(
        anchor.plan,
        anchor.anchorNodeId,
        {
          action: choice.action,
          topology: shape,
          route,
          actor,
          actors,
          instruction: text
        },
        ctx
      )
    )
    return (
      results.find((result) => 'plan' in result) ??
      results[0] ?? {
        reason: translate('nextStep.noUsablePlanAgent', 'No usable agent on this execution host.')
      }
    )
  }
  const available = choices.filter(
    (choice) => 'plan' in propose(choice, 'solo', human(choice) ? 'human' : 'new-session')
  )
  const choice = available.find((row) => row.id === selected) ?? available[0]
  const proposed = choice ? propose(choice) : null
  const plan = proposed && 'plan' in proposed ? proposed.plan : null
  const summary = plan ? workPlanSummary(plan, ctx.placement === 'card' ? 1 : 3) : null
  const route = where ?? (choice && human(choice) ? 'human' : 'new-session')
  const choose = (row: Choice) => {
    setSelected(row.id)
    setInstruction(null)
    setTopology('solo')
    setWhere(null)
    setExternal(false)
    setDestination(null)
    setAgentOpen(false)
    setRecipient(null)
    onWhere(null)
    setError('')
  }
  const send = async () => {
    if (!plan || !choice || sending.current) {
      return
    }
    sending.current = true
    setPending(true)
    setError('')
    try {
      const result = await onSend(plan, choice.id === 'change-strategy')
      if ('problems' in result) {
        setError(result.problems.map((problem) => problem.message).join('\n'))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      sending.current = false
      setPending(false)
    }
  }
  return (
    <div className="space-y-2" data-work-plan-questions>
      <p className="px-2 text-xs font-medium">
        {translate('nextStep.whatNext', 'WHAT should happen next?')}
      </p>
      <div data-work-plan-recommendations>
        {available
          .filter((row) => recommended.some((r) => r.id === row.id))
          .map((row) => (
            <MenuItem key={row.id} selected={choice?.id === row.id} onChoose={() => choose(row)}>
              {row.label}
            </MenuItem>
          ))}
      </div>
      <details>
        <summary className="cursor-pointer px-2 text-xs">
          {translate('nextStep.allActions', 'All actions')}
        </summary>
        {available
          .filter((row) => !recommended.some((r) => r.id === row.id))
          .map((row) => (
            <MenuItem key={row.id} selected={choice?.id === row.id} onChoose={() => choose(row)}>
              {row.label}
            </MenuItem>
          ))}
      </details>
      {choice ? (
        <>
          <p className="px-2 text-xs" data-work-plan-selection>
            {choice.label}
          </p>
          <WorkPlanRouting
            topology={topology}
            route={route}
            external={external}
            destination={destination}
            available={(shape, nextRoute) => 'plan' in propose(choice, shape, nextRoute ?? route)}
            onTopology={(shape) => {
              setTopology(shape)
              setError('')
            }}
            onRoute={(nextRoute) => {
              setWhere(nextRoute)
              setDestination(null)
              setExternal(false)
              setAgentOpen(false)
              onWhere(null)
            }}
            onExternal={(kind) => {
              setDestination(kind)
              setWhere(kind === 'person' ? 'human' : 'new-session')
              setExternal(kind !== 'agent')
              setAgentOpen(kind === 'agent')
              onWhere(
                kind === 'agent' ? null : kind,
                choice.action,
                instruction ?? choice.instruction
              )
            }}
          />
          {agentOpen && data ? (
            <MenuRecipients
              kind="agent"
              data={data}
              level={{ mode: 'handoff', recipients: recipient ? [recipient] : [] }}
              onMode={(mode) => {
                if (mode === 'review') {
                  const review = available.find((row) => row.id === 'review')
                  if (review) {
                    choose(review)
                  }
                }
              }}
              onPreview={() => {}}
              onPick={(picked) => {
                setRecipient(picked)
                setError('')
              }}
            />
          ) : null}
          <Textarea
            aria-label={translate('nextStep.nextInstruction', 'Next instruction')}
            value={instruction ?? choice.instruction}
            onChange={(event) => {
              setSelected(choice.id)
              setInstruction(event.target.value)
              setError('')
            }}
          />
          {plan ? (
            <div className="space-y-1 px-2 text-xs" aria-live="polite">
              <p data-work-plan-notation>{workPlanNotation(plan)}</p>
              <p className="text-muted-foreground">
                {translate(
                  'nextStep.planExecutionSummary',
                  '{{executions}} executions · {{stages}} stages · {{queued}} queued',
                  summary!
                )}
              </p>
            </div>
          ) : (
            <p role="alert">{proposed && 'reason' in proposed ? proposed.reason : ''}</p>
          )}
          {!external ? (
            <Button size="sm" disabled={pending || !plan} onClick={() => void send()}>
              {translate('nextStep.send', 'Send')}
            </Button>
          ) : null}
        </>
      ) : (
        <p className="px-2 text-xs text-muted-foreground">
          {translate(
            'nextStep.noAvailableFragment',
            'No available next step for this plan and execution host.'
          )}
        </p>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
