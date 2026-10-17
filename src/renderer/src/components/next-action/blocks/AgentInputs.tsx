import { translate as t } from '@/i18n/i18n'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  WORK_PLAN_REVIEW_STOP_RULES,
  type WorkPlanReviewStop
} from '../../../../../shared/work-plan-types'
import type { UpNextAgentBlock, UpNextView } from '../../../../../shared/up-next-types'
import type { UpNextController } from '../use-up-next'
import { blockTitle } from '../up-next-labels'

export function AgentInputs({
  block,
  view,
  controller
}: {
  block: UpNextAgentBlock
  view: UpNextView
  controller: UpNextController
}) {
  const predecessors = view.blocks
    .slice(
      0,
      Math.max(
        0,
        view.blocks.findIndex((item) => item.id === block.id)
      )
    )
    .filter((item) => item.kind === 'agent')
  return (
    <>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-16 text-muted-foreground">{t('upNext.stopWhen', 'Stop when')}</span>
        <Select
          disabled={controller.disabled}
          value={block.advanced.stopWhen ?? 'default'}
          onValueChange={(stopWhen) =>
            void controller.update(block.id, {
              kind: 'agent',
              advanced: {
                ...block.advanced,
                stopWhen: stopWhen === 'default' ? undefined : (stopWhen as WorkPlanReviewStop)
              }
            })
          }
        >
          <SelectTrigger aria-label={t('upNext.stopWhen', 'Stop when')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">{t('upNext.agentDefault', 'Agent default')}</SelectItem>
            {WORK_PLAN_REVIEW_STOP_RULES.map((rule) => (
              <SelectItem value={rule} key={rule}>
                {t(`upNext.stopRule.${rule}`, rule.replaceAll('_', ' '))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {predecessors.length > 0 && (
        <div className="space-y-1">
          <p className="text-muted-foreground">{t('upNext.readsFrom', 'Reads from')}</p>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={block.advanced.readsFrom === undefined}
              onChange={(event) =>
                void controller.update(block.id, {
                  kind: 'agent',
                  advanced: {
                    ...block.advanced,
                    readsFrom: event.target.checked
                      ? undefined
                      : predecessors.map((item) => item.id)
                  }
                })
              }
            />
            {t('upNext.implicitInputs', 'Earlier stages (automatic)')}
          </label>
          {block.advanced.readsFrom !== undefined &&
            predecessors.map((item) => (
              <label className="flex gap-2" key={item.id}>
                <input
                  type="checkbox"
                  checked={block.advanced.readsFrom?.includes(item.id) ?? true}
                  onChange={(event) => {
                    // Only blocks still ABOVE this one: a stage the person has since removed is no
                    // name the commit can resolve, and it refuses rather than quietly reading the
                    // stage above instead.
                    const selected = (
                      block.advanced.readsFrom ?? predecessors.map((candidate) => candidate.id)
                    ).filter((id) => predecessors.some((candidate) => candidate.id === id))
                    void controller.update(block.id, {
                      kind: 'agent',
                      advanced: {
                        ...block.advanced,
                        readsFrom: event.target.checked
                          ? [...selected, item.id]
                          : selected.filter((id) => id !== item.id)
                      }
                    })
                  }}
                />
                {item.number} · {blockTitle(item)}
              </label>
            ))}
        </div>
      )}
    </>
  )
}
