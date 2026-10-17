import { equalShares, normalizeSessionGridLayout, sessionGridPaneIds } from './session-grid-layout'
import type { SessionGridPane, SessionGridSnapshot } from './session-grid-panes'

export const SESSION_GRID_TEMPLATES = [
  'Default',
  'Development',
  'Monitoring',
  'Maximum',
  'Focused'
] as const
export type SessionGridTemplate = (typeof SESSION_GRID_TEMPLATES)[number]

const TEMPLATE_VIEWS: Record<SessionGridTemplate, string[]> = {
  Default: ['session-chooser', 'omnios-decisions', 'ready', 'overview'],
  Development: [
    'session-chooser',
    'session-chooser',
    'session-chooser',
    'session-chooser',
    'ready',
    'section:stats'
  ],
  Monitoring: ['section:happening', 'omnios-decisions', 'overview', 'section:stats'],
  Maximum: [
    'session-chooser',
    'session-chooser',
    'session-chooser',
    'session-chooser',
    'ready',
    'section:stats',
    'section:dispatch',
    'omnios-decisions'
  ],
  Focused: ['session-chooser', 'ready', 'overview']
}

/** Reuse live pane ids; applying a template changes geometry, never execution. */
export function applyGridTemplate(
  state: SessionGridSnapshot,
  template: SessionGridTemplate
): SessionGridSnapshot {
  const shown = sessionGridPaneIds(state.layout)
  const live = shown.filter((id) => state.panes[id]?.kind === 'session')
  const desired = TEMPLATE_VIEWS[template]
  const count = Math.max(live.length, desired.length)
  const panes = { ...state.panes }
  const ids = [...live]
  for (let index = live.length; index < count; index += 1) {
    const viewId = desired[index] ?? 'session-chooser'
    const reusable = Object.values(panes).find(
      (pane) => pane.kind === 'view' && pane.viewId === viewId && !ids.includes(pane.id)
    )
    const pane: SessionGridPane = reusable ?? {
      id: `pane-${crypto.randomUUID()}`,
      kind: 'view',
      viewId,
      ...(template === 'Default' && index === 0 ? { selectDefault: true } : {})
    }
    panes[pane.id] = pane
    ids.push(pane.id)
  }
  const split = template === 'Focused' && count <= 5 ? 1 : Math.ceil(count / 2)
  const tracks = count === 1 ? [ids] : [ids.slice(0, split), ids.slice(split)]
  return {
    ...state,
    panes,
    layout: normalizeSessionGridLayout({
      orientation: 'columns',
      tracks,
      trackSizes: template === 'Focused' ? [0.7, 0.3] : equalShares(tracks.length),
      paneSizes: tracks.map((track) => equalShares(track.length))
    }),
    minimized: [
      ...new Set([...shown.filter((id) => !ids.includes(id)), ...state.minimized])
    ].filter((id) => !ids.includes(id)),
    focusedPaneId:
      state.focusedPaneId && ids.includes(state.focusedPaneId) ? state.focusedPaneId : null
  }
}
