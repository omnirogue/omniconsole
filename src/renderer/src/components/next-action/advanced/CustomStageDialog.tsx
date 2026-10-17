import { isTuiAgent } from '../../../../../shared/tui-agent-config'
import { useState } from 'react'
import { WorkPlanComposerDialog } from '@/components/work-plan/composer/WorkPlanComposerDialog'
import { useWorkPlanContext } from '@/components/work-plan/use-work-plan-context'
import { useSessionSourceActor } from '@/components/session-team/use-session-source-actor'
import { translate as t } from '@/i18n/i18n'
import type { UpNextAgentBlock, UpNextView } from '../../../../../shared/up-next-types'
import type { UpNextController } from '../use-up-next'
import { useAdvancedSession } from './advanced-session-context'
import { customStagePatch, stagePlan } from './custom-stage-adapter'

export function CustomStageDialog({
  block,
  view,
  controller,
  onClose
}: {
  block: UpNextAgentBlock
  view: UpNextView
  controller: UpNextController
  onClose: () => void
}) {
  const context = useWorkPlanContext(
    undefined,
    'worktreeId' in view.conversationId ? view.conversationId.worktreeId : undefined
  )
  const source = useSessionSourceActor(useAdvancedSession())
  const agent = source?.agent ?? (view.now.kind === 'current-work' ? view.now.agent : '')
  const [error, setError] = useState('')
  if (!isTuiAgent(agent)) {
    return (
      <p role="alert">
        {t(
          'upNext.customAgentUnavailable',
          'The current agent is unavailable. Custom stage editing cannot open yet.'
        )}
      </p>
    )
  }
  return (
    <WorkPlanComposerDialog
      open
      useError={error || controller.error || undefined}
      useDisabled={controller.disabled}
      plan={stagePlan(block, { agent })}
      ctx={{ ...context, source }}
      capacity={9}
      onCancel={onClose}
      onUse={(plan) => {
        if (controller.disabled) {
          return
        }
        const result = customStagePatch(plan, block, agent)
        if ('reason' in result) {
          setError(
            result.reason === 'multiStage'
              ? t(
                  'upNext.multiStageUnavailable',
                  'The composer engine does not yet support multi-stage patches here.'
                )
              : t(
                  'upNext.customPatchUnavailable',
                  'This stage contains settings that the host cannot preserve yet. The block has not changed.'
                )
          )
          return
        }
        void controller.update(block.id, result.patch).then((ok) => {
          if (ok) {
            onClose()
          }
        })
      }}
    />
  )
}
