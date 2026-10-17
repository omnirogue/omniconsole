import type { SidebarLayout } from './sidebar-layout'

export type SidebarCustomGroup = { id: string; name: string }
export const MAX_SIDEBAR_GROUPS = 24
export const SIDEBAR_GROUPS_CAPABILITY = 'client-ui.sidebar-groups.v1'

export function supportsSidebarGroups(
  pairedWeb: boolean,
  capabilities?: readonly string[]
): boolean {
  return !pairedWeb || capabilities?.includes(SIDEBAR_GROUPS_CAPABILITY) === true
}

export function decodeSidebarGroups(value: unknown): SidebarCustomGroup[] {
  if (!Array.isArray(value)) {
    return []
  }
  const groups: SidebarCustomGroup[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const { id, name } = entry as Record<string, unknown>
    if (
      typeof id !== 'string' ||
      !/^custom-[a-z0-9-]{1,80}$/.test(id) ||
      typeof name !== 'string' ||
      !name.trim() ||
      groups.length >= MAX_SIDEBAR_GROUPS
    ) {
      continue
    }
    const label = name.trim().slice(0, 80)
    if (
      groups.some((group) => group.id === id || group.name.toLowerCase() === label.toLowerCase())
    ) {
      continue
    }
    groups.push({ id, name: label })
  }
  return groups
}

export function withSidebarGroup(layout: SidebarLayout, id: string, name: string): SidebarLayout {
  const groups = decodeSidebarGroups([...(layout.groups ?? []), { id, name }])
  return groups.length === (layout.groups?.length ?? 0) ? layout : { ...layout, groups }
}

export function withoutSidebarGroup(layout: SidebarLayout, id: string): SidebarLayout {
  if (!layout.groups?.some((group) => group.id === id)) {
    return layout
  }
  const scope = `nav:${id}`
  const orders = { ...layout.orders }
  // Settings shortcuts have no default group; return them to Agents when their group goes away.
  const pins = (orders[scope] ?? []).filter((member) => member.startsWith('settings:'))
  if (pins.length) {
    orders['nav:agents'] = [...new Set([...(orders['nav:agents'] ?? []), ...pins])]
  }
  delete orders[scope]
  if (orders.nav) {
    orders.nav = orders.nav.filter((member) => member !== scope)
  }
  const hidden = { ...layout.hidden }
  delete hidden[scope]
  const groups = layout.groups.filter((group) => group.id !== id)
  const { groups: _groups, ...rest } = layout
  return { ...rest, orders, hidden, ...(groups.length ? { groups } : {}) }
}
