import type { TopLevelView } from './ui-chrome-types'

export function isCommandCenterView(view: TopLevelView): view is 'attention' | 'grid' {
  return view === 'attention' || view === 'grid'
}

export function commandCenterTarget(
  enabled: boolean | undefined,
  previousTarget: TopLevelView = 'grid'
): TopLevelView {
  return enabled === true ? 'attention' : previousTarget
}

/** The legacy Attention page stays separate from the grid until enabled. */
export function isSessionGridView(view: TopLevelView, enabled: boolean | undefined): boolean {
  return isCommandCenterView(view) && (enabled === true || view === 'grid')
}
