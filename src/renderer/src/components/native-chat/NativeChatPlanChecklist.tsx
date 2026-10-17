import { useMemo } from 'react'
import { Check, ChevronDown, Circle, CircleDot, ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { NativeChatPlan } from '../../../../shared/native-chat-plan'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  nativeChatPlanEntryRows,
  selectLatestNativeChatPlan,
  summarizeNativeChatPlan
} from './native-chat-plan-checklist'

export function NativeChatSessionPlan({ messages }: { messages: readonly NativeChatMessage[] }) {
  const plan = useMemo(() => selectLatestNativeChatPlan(messages), [messages])
  return plan ? <NativeChatPlanChecklist plan={plan} /> : null
}

export function NativeChatPlanChecklist({ plan }: { plan: NativeChatPlan }) {
  const { completed, total, current, next } = summarizeNativeChatPlan(plan)
  if (total === 0) {
    return null
  }
  const count = translate('components.native-chat.plan.count', '{{completed}}/{{total}} complete', {
    completed,
    total
  })
  const summary = current
    ? translate('components.native-chat.plan.current', 'Current: {{step}}', {
        step: current.content
      })
    : next
      ? translate('components.native-chat.plan.next', 'Next: {{step}}', { step: next.content })
      : translate('components.native-chat.plan.complete', 'All steps reported complete')

  return (
    <Collapsible className="shrink-0 border-b" data-native-chat-plan>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="group h-auto w-full justify-start rounded-none px-3 py-1.5 text-left"
        >
          <ListChecks className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-2 text-xs">
              <span>{translate('components.native-chat.plan.title', 'Agent checklist')}</span>
              <span className="shrink-0 font-normal tabular-nums text-muted-foreground">
                {count}
              </span>
            </span>
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {summary}
            </span>
          </span>
          <ChevronDown
            className="size-3 text-muted-foreground motion-safe:transition-transform group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="scrollbar-sleek max-h-48 overflow-y-auto px-3 pb-2">
          {plan.explanation ? (
            <p className="mb-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {plan.explanation}
            </p>
          ) : null}
          <ol className="space-y-1.5">
            {nativeChatPlanEntryRows(plan).map(({ key, entry }) => {
              const active = entry.status === 'in_progress'
              const Icon = entry.status === 'completed' ? Check : active ? CircleDot : Circle
              const label =
                entry.status === 'completed'
                  ? translate('components.native-chat.plan.completed', 'Completed')
                  : active
                    ? translate('components.native-chat.plan.inProgress', 'In progress')
                    : translate('components.native-chat.plan.pending', 'Pending')
              return (
                <li
                  key={key}
                  className={cn(
                    'flex items-start gap-2 text-xs',
                    active ? 'text-foreground' : 'text-muted-foreground'
                  )}
                  aria-current={active ? 'step' : undefined}
                >
                  <Icon
                    className={cn('mt-0.5 size-3 shrink-0', active && 'text-status-info')}
                    aria-hidden="true"
                  />
                  <span className="sr-only">{label}: </span>
                  <span className="min-w-0 whitespace-pre-wrap break-words">{entry.content}</span>
                </li>
              )
            })}
          </ol>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
