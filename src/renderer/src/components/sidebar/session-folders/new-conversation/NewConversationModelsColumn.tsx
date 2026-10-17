import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { HoverOpenContentProps } from '@/components/next-step/use-hover-open-popover'
import type { CatalogModel } from '../../../../../../shared/agent-session-option-catalog'
import type { AccountCapacityRow } from '../../../../../../shared/provider-account-capacity'
import { effortChoicesFor } from '../../../../../../shared/build-review-model-options'
import { checkAgentLaunchPreferences } from '../../../../../../shared/agent-launch-preference-check'
import type { LaunchPick, LauncherProvider } from './resolve-launch-plan'
import { LauncherMenuRow } from './LauncherMenuRow'

export function NewConversationModelsColumn({
  agent,
  account,
  models,
  start,
  hover
}: {
  agent: LauncherProvider
  account?: AccountCapacityRow
  models: CatalogModel[]
  start: (pick: LaunchPick) => void
  hover: HoverOpenContentProps
}): React.JSX.Element {
  const saved = useAppStore((state) => state.settings?.conversationLaunchDefaults?.[agent])
  const save = async (model: string | undefined, effort?: string): Promise<void> => {
    const state = useAppStore.getState()
    try {
      await state.updateSettingsOrThrow({
        conversationLaunchDefaults: {
          ...state.settings?.conversationLaunchDefaults,
          [agent]: { ...state.settings?.conversationLaunchDefaults?.[agent], model, effort }
        }
      })
    } catch (error) {
      toast.error(translate('conversationLauncher.saveFailed', 'Could not save launch defaults.'), {
        description: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return (
    <>
      {[
        { id: undefined, label: translate('conversationLauncher.default', 'Default') },
        ...models
      ].map((model) => {
        const efforts = model.id
          ? effortChoicesFor(agent, models, model.id).filter(
              (effort) =>
                checkAgentLaunchPreferences(agent, { model: model.id, effort: effort.value }).ok
            )
          : []
        return (
          <LauncherMenuRow
            key={model.id ?? 'default'}
            hover={hover}
            isDefault={saved?.model === model.id}
            onDefault={() => void save(model.id, saved?.effort)}
            onLaunch={() => start({ agent, account, model: model.id })}
            submenu={
              efforts.length
                ? efforts.map((effort) => (
                    <LauncherMenuRow
                      key={effort.value}
                      hover={hover}
                      isDefault={saved?.model === model.id && saved?.effort === effort.value}
                      onDefault={() => void save(model.id, effort.value)}
                      onLaunch={() =>
                        start({ agent, account, model: model.id, effort: effort.value })
                      }
                    >
                      {effort.label}
                    </LauncherMenuRow>
                  ))
                : undefined
            }
          >
            {model.label}
          </LauncherMenuRow>
        )
      })}
    </>
  )
}
