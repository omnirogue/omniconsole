import { AgentInputs } from '../blocks/AgentInputs'
import { AgentModelFields } from './AgentModelFields'
import { Input } from '@/components/ui/input'
import { translate as t } from '@/i18n/i18n'
import type { UpNextAgentBlock, UpNextView } from '../../../../../shared/up-next-types'
import { WORK_PLAN_MAX_REVIEW_ROUNDS } from '../../../../../shared/work-plan-types'
import type { UpNextController } from '../use-up-next'

export function AgentAdvanced({
  block,
  view,
  controller
}: {
  block: UpNextAgentBlock
  view: UpNextView
  controller: UpNextController
}) {
  const update = (patch: Parameters<UpNextController['update']>[1]) =>
    void controller.update(block.id, patch)
  return (
    <div className="mt-2 space-y-2">
      <AgentModelFields
        block={block}
        view={view}
        onChange={(value) =>
          update({
            kind: 'agent',
            advanced: { ...block.advanced, model: value.model, effort: value.effort }
          })
        }
      />
      <label>
        {t('upNext.rounds', 'Rounds')}
        <Input
          type="number"
          min={1}
          max={WORK_PLAN_MAX_REVIEW_ROUNDS}
          value={block.advanced.rounds ?? 1}
          onChange={(event) => {
            const rounds = Number(event.target.value)
            if (rounds >= 1 && rounds <= WORK_PLAN_MAX_REVIEW_ROUNDS) {
              update({ kind: 'agent', advanced: { ...block.advanced, rounds } })
            }
          }}
        />
      </label>
      <AgentInputs block={block} view={view} controller={controller} />
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={block.advanced.endOnSuccess ?? false}
          onChange={(event) =>
            update({
              kind: 'agent',
              advanced: { ...block.advanced, endOnSuccess: event.target.checked }
            })
          }
        />
        {t('upNext.endSuccess', 'End this session when it completes successfully')}
      </label>
    </div>
  )
}
