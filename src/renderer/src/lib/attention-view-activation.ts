import { isCommandCenterView } from '../../../shared/command-center-navigation'
import type { TopLevelView } from '../../../shared/ui-chrome-types'

/**
 * Whether activating a workspace must leave the current top-level view for the
 * terminal workbench. The attention view is a mode over terminals: a plain pick
 * (sidebar row, palette) only swaps its "working on" slot, while activation that
 * carries setup/startup work needs the real workbench chrome.
 */
export function shouldSwitchToTerminalViewOnActivation(
  activeView: TopLevelView,
  hasActivationWork: boolean,
  commandCenter = false
): boolean {
  if (activeView === 'terminal') {
    return false
  }
  return !(
    (commandCenter ? isCommandCenterView(activeView) : activeView === 'attention') &&
    !hasActivationWork
  )
}
