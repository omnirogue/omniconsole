import {
  findCatalogModel,
  findCatalogOption,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import type {
  SessionOptionSetResult,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import { translate } from '@/i18n/i18n'
import { getTrackedSessionOption } from '../../../../shared/native-chat-session-option-state'
import {
  codexResumeRelaunchLabel,
  codexResumeRelaunchModelUnknownCopy,
  codexResumeRelaunchSameValueCopy,
  codexResumeRelaunchUnavailableCopy
} from './codex-resume-relaunch-copy'
import {
  finishSessionOptionApply,
  type SessionOptionApplyContext
} from './native-chat-session-option-apply-context'

function effortSupportedOn(
  ctx: SessionOptionApplyContext,
  models: readonly CatalogModel[],
  modelId: string,
  effort: string
): boolean {
  const option =
    findCatalogOption(
      findCatalogModel({ ...ctx.catalog, models: [...models] }, modelId),
      'effort'
    ) ?? ctx.catalog.unknownModelOptions?.find((candidate) => candidate.id === 'effort')
  return option?.kind.type === 'select' && option.kind.choices.some((c) => c.value === effort)
}

/**
 * Applies a `resume-relaunch` option by restarting the CLI on the same thread.
 * Nothing is typed into the TUI; tracked truth is only touched inside
 * `onCommitted`, which the relaunch hook calls after its post-drain precondition
 * passes and immediately before it queues the restart — a refusal throws first
 * and leaves the picker exactly as it was.
 */
export async function applyResumeRelaunch(
  ctx: SessionOptionApplyContext,
  args: { id: string; value: SessionOptionValue; modelId: string | null }
): Promise<SessionOptionSetResult> {
  const { id, value, modelId } = args
  const relaunch = ctx.relaunchSessionOptions
  if (!relaunch) {
    throw new Error(codexResumeRelaunchUnavailableCopy())
  }
  if (typeof value !== 'string') {
    throw new Error(
      translate(
        'components.native-chat.composer.relaunchRefusedValueRequired',
        'This option requires a value.'
      )
    )
  }
  const targetModel = id === 'model' ? value : modelId
  if (!targetModel) {
    throw new Error(codexResumeRelaunchModelUnknownCopy())
  }
  const models = ctx.getModels()
  const record = ctx.getRecord()
  // Why the current model: a model pick carries the effort the user is on now.
  const currentEffort = getTrackedSessionOption(record, modelId, 'effort')
  const currentEffortValue =
    typeof currentEffort?.value === 'string' ? currentEffort.value : undefined
  if (id === 'model' && modelId === value) {
    throw new Error(
      codexResumeRelaunchSameValueCopy(codexResumeRelaunchLabel({ model: value }, models))
    )
  }
  if (id === 'effort' && currentEffortValue === value) {
    throw new Error(
      codexResumeRelaunchSameValueCopy(
        codexResumeRelaunchLabel({ model: targetModel, effort: value }, models)
      )
    )
  }
  // Why: when the destination model cannot take the carried effort, no `-c` is sent
  // and Codex applies its own default, which the header scrape then reports.
  const targetEffort =
    id === 'effort'
      ? value
      : currentEffortValue && effortSupportedOn(ctx, models, targetModel, currentEffortValue)
        ? currentEffortValue
        : undefined
  await relaunch({
    requested: { model: targetModel, ...(targetEffort ? { effort: targetEffort } : {}) },
    // Why: the carried effort is for the launch line only; persisting it on a model
    // pick would rewrite the new model's saved default with a value nobody picked.
    selectedOption: id === 'model' ? 'model' : 'effort',
    onCommitted: () => {
      if (id === 'model' && modelId !== value) {
        record.model = undefined
        delete record.valuesByModel[value]
      }
      ctx.setTrackedValue('model', targetModel, 'dispatched')
      if (targetEffort) {
        ctx.setTrackedValue('effort', targetEffort, 'dispatched')
      }
      ctx.publish()
    }
  })
  return finishSessionOptionApply(ctx, {
    modelId: targetModel,
    optionId: id,
    value,
    skipPersist: true
  })
}
