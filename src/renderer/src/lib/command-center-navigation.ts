import type { AppState } from '@/store/types'
import { commandCenterTarget } from '../../../shared/command-center-navigation'
import type { TopLevelView } from '../../../shared/ui-chrome-types'

export {
  commandCenterTarget,
  isCommandCenterView,
  isSessionGridView
} from '../../../shared/command-center-navigation'

export function openCommandCenter(
  state: Pick<AppState, 'settings' | 'setActiveView'>,
  previousTarget: TopLevelView = 'grid'
): void {
  const view = commandCenterTarget(state.settings?.commandCenter, previousTarget)
  state.setActiveView(view)
}
