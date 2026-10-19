import type { HoverOpenContentProps } from '@/components/next-step/use-hover-open-popover'
import type {
  AccountCapacityRow,
  CapacityProvider
} from '../../../../../../shared/provider-account-capacity'
import { NewConversationAccountsColumn } from './NewConversationAccountsColumn'
import { NewConversationModelsColumn } from './NewConversationModelsColumn'
import { OmpLaunchModels } from './OmpLaunchModels'
import { CustomModelsSection } from './CustomModelsSection'
import type { LaunchPick, LauncherCapability, LauncherProvider } from './resolve-launch-plan'

/** Providers with models or accounts to choose before launching. */
export function providerHasLaunchSubmenu(agent: LauncherProvider): boolean {
  return (
    agent === 'claude' ||
    agent === 'codex' ||
    agent === 'omp' ||
    agent === 'muse' ||
    agent === 'deepseek'
  )
}

/** One provider row's submenu body, shared by the "+" menu and the palette's right-click menu. */
export function LauncherProviderSubmenu(props: {
  agent: LauncherProvider
  entry: LauncherCapability
  rows: Record<CapacityProvider, AccountCapacityRow[]>
  local: boolean
  hover: HoverOpenContentProps
  start: (pick: LaunchPick) => void
  starting?: boolean
  launchError?: string
}) {
  if (props.agent === 'omp') {
    return (
      <>
        <OmpLaunchModels
          start={props.start}
          starting={props.starting}
          launchError={props.launchError}
        />
        {/* Why: custom models are OpenRouter presets launched through OMP; they belong with it. */}
        <CustomModelsSection
          start={props.start}
          starting={props.starting}
          launchError={props.launchError}
          hover={props.hover}
        />
      </>
    )
  }
  if (props.agent === 'muse' || props.agent === 'deepseek') {
    return (
      <NewConversationModelsColumn
        agent={props.agent}
        models={props.entry.models}
        start={props.start}
        hover={props.hover}
      />
    )
  }
  if (props.agent !== 'claude' && props.agent !== 'codex') {
    return null
  }
  return (
    <NewConversationAccountsColumn
      agent={props.agent}
      rows={props.rows[props.agent]}
      models={props.entry.models}
      local={props.local}
      start={props.start}
      hover={props.hover}
    />
  )
}
