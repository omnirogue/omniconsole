import type { Ref } from 'react'
import { defaultNextStepInstructions } from '../../../../shared/next-step-draft'
import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { upNextCanAdd } from '../../../../shared/up-next-order'
import {
  UP_NEXT_MAX_BLOCKS,
  type UpNextAgentTemplate,
  type UpNextView,
  type UpNextBlockKind,
  type UpNextDraftInput
} from '../../../../shared/up-next-types'
import type { UpNextController } from './use-up-next'
import { kindLabel } from './up-next-labels'
import { offersFixHint } from './up-next-chain-rules'
import { AgentIntentMenu } from './AgentIntentMenu'
import type { UpNextAgentIntent } from '../../../../shared/up-next-agent-intent'

/**
 * The add bar's controls, in order. The agent kind is offered twice, once per intent — review
 * (inspect and report) and handoff (the next agent acts) — each with its own menu; both append
 * the same agent stage the engine has always run, carrying the template picked.
 */
const ADD_CONTROLS: readonly (
  | { kind: Exclude<UpNextBlockKind, 'agent'> }
  | { kind: 'agent'; intent: UpNextAgentIntent }
)[] = [
  { kind: 'prompt' },
  { kind: 'agent', intent: 'review' },
  { kind: 'agent', intent: 'handoff' },
  { kind: 'person' }
]

export function AddBlockBar({
  ref,
  view,
  controller,
  onAdded
}: {
  /** The bar itself, so a request's "open Up next" action can put the person on it. */
  ref?: Ref<HTMLDivElement>
  view: UpNextView
  controller: UpNextController
  onAdded: () => void
}) {
  const allowed = upNextCanAdd(view.blocks, view.header.state)
  return (
    <div ref={ref} className="flex min-w-0 flex-wrap items-center gap-2" data-up-next-add>
      {ADD_CONTROLS.map((control) => {
        const kind = control.kind
        const reason = allowed.reasons[kind] ?? view.canAdd.reasons[kind]
        const limit = view.blocks.length >= UP_NEXT_MAX_BLOCKS
        const disabled = controller.disabled || !allowed[kind] || !view.canAdd[kind] || limit
        const title = reason
          ? t(reason, reason)
          : limit
            ? t('upNext.blockLimit', 'This track has reached its block limit.')
            : (controller.error ?? undefined)
        const add = async (draft: UpNextDraftInput): Promise<void> => {
          if (await controller.append(draft)) {
            onAdded()
          }
        }
        if (control.kind === 'agent') {
          return (
            <AgentIntentMenu
              key={`agent-${control.intent}`}
              intent={control.intent}
              disabled={disabled}
              title={title}
              onPick={(template: UpNextAgentTemplate) =>
                void add({
                  kind: 'agent',
                  template,
                  shape: 'solo',
                  n: 1,
                  // Custom compiles to the implement role (`upNextRole`), so it starts from that
                  // instruction for the person to rewrite rather than running with none.
                  instruction: defaultNextStepInstructions(
                    template === 'custom' ? 'implement' : template
                  )
                })
              }
            />
          )
        }
        const drafts: Record<Exclude<UpNextBlockKind, 'agent'>, UpNextDraftInput> = {
          prompt: {
            kind: 'prompt',
            text: t('upNext.defaultPrompt', 'Is there anything else we can do to improve?'),
            when: view.header.state === 'idle' ? 'now' : 'after'
          },
          // Why no relationship: "wait for their OK" reads as its default until touched.
          person: {
            kind: 'person',
            receive: { files: true, transcript: true, createTaskCard: false }
          },
          done: { kind: 'done', finish: 'close' }
        }
        return (
          <Button
            key={kind}
            type="button"
            size="sm"
            variant="outline"
            className={cn('rounded-lg font-semibold', kind === 'done' && 'border-foreground/60')}
            disabled={disabled}
            title={title}
            onClick={() => void add(drafts[control.kind])}
          >
            {kind === 'done' ? kindLabel(kind) : `+ ${kindLabel(kind)}`}
          </Button>
        )
      })}
      {offersFixHint(view) && (
        <p className="ml-auto min-w-0 break-words text-xs text-muted-foreground">
          {t('upNext.fixHint', 'Add an Agent Handoff to fix it.')}
        </p>
      )}
    </div>
  )
}
