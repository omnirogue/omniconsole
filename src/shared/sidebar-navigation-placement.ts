import {
  orderedIds,
  insert,
  withoutHidden,
  type DropSide,
  type SidebarLayout
} from './sidebar-layout'

export const SIDEBAR_MEMBER_SCOPES = ['nav:work', 'nav:agents'] as const
export type SidebarMemberScope = (typeof SIDEBAR_MEMBER_SCOPES)[number] | `nav:custom-${string}`

export function sidebarMemberScopes(layout: SidebarLayout): SidebarMemberScope[] {
  return [
    ...SIDEBAR_MEMBER_SCOPES,
    ...(layout.groups ?? []).map((group) => `nav:${group.id}` as SidebarMemberScope)
  ]
}

export function isSidebarMemberScope(scope: string): scope is SidebarMemberScope {
  return (
    SIDEBAR_MEMBER_SCOPES.some((candidate) => candidate === scope) ||
    /^nav:custom-[a-z0-9-]{1,80}$/.test(scope)
  )
}

export function sidebarMemberScope(
  layout: SidebarLayout,
  id: string,
  fallback: SidebarMemberScope | null
): SidebarMemberScope | null {
  return sidebarMemberScopes(layout).find((scope) => layout.orders[scope]?.includes(id)) ?? fallback
}

export function withSidebarMemberPlacement(
  layout: SidebarLayout,
  id: string,
  scope: string,
  visibleOrder: readonly string[],
  target: string | null = null,
  side: DropSide = 'after'
): SidebarLayout {
  if (
    !isSidebarMemberScope(scope) ||
    !sidebarMemberScopes(layout).includes(scope) ||
    !/^(work|agents|settings):[^:]+$/.test(id)
  ) {
    return layout
  }
  const orders = { ...layout.orders }
  for (const group of sidebarMemberScopes(layout)) {
    if (orders[group]) {
      orders[group] = orders[group].filter((candidate) => candidate !== id)
    }
  }
  const defaults =
    scope === 'nav:work'
      ? [
          'work:inbox',
          'work:setup',
          'work:attention',
          'work:tasks',
          'work:kanban',
          'work:calendar',
          'work:advertising',
          'work:decisions'
        ]
      : scope === 'nav:agents'
        ? [
            'agents:artifacts',
            'agents:skills',
            'agents:office',
            'agents:buildReview',
            'agents:localRuns',
            'agents:machines',
            'agents:automations',
            'agents:activity',
            'agents:dashboard',
            'agents:mobile'
          ]
        : []
  const available = defaults.filter(
    (candidate) => sidebarMemberScope(layout, candidate, scope) === scope
  )
  const order =
    target === null ? orderedIds([...visibleOrder, ...available], visibleOrder) : visibleOrder
  orders[scope] = insert(order, id, target, side)
  return { ...withoutHidden(withoutHidden(layout, scope), id), orders }
}
