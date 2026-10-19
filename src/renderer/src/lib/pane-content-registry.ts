import { Globe, LayoutDashboard, NotebookPen, SquareTerminal, type LucideIcon } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { navGroup } from '@/components/sidebar/sidebar-nav-groups'
import { WORK_PAGE_SECTIONS } from '@/components/work/work-page-sections'
import type { TopLevelView } from '../../../shared/ui-chrome-types'

export type PaneContentEntry = {
  id: string
  label: string | (() => string)
  icon: LucideIcon
  group: 'Sessions' | 'Sessions info' | 'Work pages' | 'Work sections' | 'Tools'
  mount: 'embedded' | 'full-page' | 'placeholder' | 'chooser'
  multiple: boolean
  subscriptions: readonly string[]
  fullPage?: TopLevelView
}
const PAGE_LABELS: Partial<Record<TopLevelView, string>> = {
  work: 'Work home',
  project: 'Projects',
  inbox: 'Inbox',
  attention: 'Attention',
  grid: 'Grid',
  tasks: 'Tasks',
  kanban: 'Kanban',
  calendar: 'Calendar',
  advertising: 'Advertising',
  companies: 'Companies',
  settings: 'Setup'
}
const EMBEDDED_PAGES = new Set<TopLevelView>(['project', 'tasks', 'kanban', 'companies'])
const EMBEDDED_SECTIONS = new Set([
  'dispatch',
  'projects',
  'needs-you',
  'happening',
  'stats',
  'companies'
])
const pages = [...navGroup('work').views, 'companies', 'settings'] as const

export const PANE_CONTENT_REGISTRY: readonly PaneContentEntry[] = [
  {
    id: 'session-chooser',
    label: () => translate('commandCenter.content.session-chooser', 'Live session'),
    icon: SquareTerminal,
    group: 'Sessions',
    mount: 'chooser',
    multiple: true,
    subscriptions: ['sidebar sessions']
  },
  {
    id: 'terminal',
    label: () => translate('commandCenter.content.terminal', 'Terminal'),
    icon: SquareTerminal,
    group: 'Sessions',
    mount: 'chooser',
    multiple: true,
    subscriptions: ['workspace inventory']
  },
  ...['ready', 'omnios-decisions', 'overview', 'session-statistics', 'artifacts'].map(
    (id): PaneContentEntry => ({
      id,
      label:
        id === 'ready'
          ? 'New Claude / Codex'
          : id === 'overview'
            ? 'Session overview'
            : id === 'session-statistics'
              ? 'Session statistics'
              : id === 'artifacts'
                ? 'Artifacts'
                : 'OmniOS Decisions',
      icon: LayoutDashboard,
      group: ['overview', 'session-statistics'].includes(id) ? 'Sessions info' : 'Sessions',
      mount: 'embedded',
      multiple: id === 'ready',
      subscriptions: id === 'ready' ? ['ready drafts'] : [`${id} snapshot`]
    })
  ),
  ...pages.map((view): PaneContentEntry => ({
    id: `page:${view}`,
    label: PAGE_LABELS[view] ?? view,
    icon: LayoutDashboard,
    group: 'Work pages',
    mount: EMBEDDED_PAGES.has(view) ? 'embedded' : 'full-page',
    multiple: false,
    subscriptions: [`${view} page stores`],
    fullPage: view
  })),
  ...WORK_PAGE_SECTIONS.map((section): PaneContentEntry => ({
    id: `section:${section.id}`,
    label: section.label,
    icon: LayoutDashboard,
    group: 'Work sections',
    mount: EMBEDDED_SECTIONS.has(section.id) ? 'embedded' : 'full-page',
    multiple: false,
    subscriptions: [`Work ${section.id} stores`],
    fullPage: 'work'
  })),
  {
    id: 'notepad',
    label: () => translate('commandCenter.content.notepad', 'Notepad'),
    icon: NotebookPen,
    group: 'Tools',
    mount: 'embedded',
    multiple: true,
    subscriptions: ['grid notes']
  },
  {
    id: 'browser',
    label: () => translate('commandCenter.content.browser', 'Browser'),
    icon: Globe,
    group: 'Tools',
    mount: 'chooser',
    multiple: true,
    subscriptions: ['browser workspace']
  }
]

export function paneContentEntry(id: string): PaneContentEntry | undefined {
  return PANE_CONTENT_REGISTRY.find((entry) => entry.id === id)
}

export function paneContentLabel(entry: PaneContentEntry): string {
  const fallback = typeof entry.label === 'function' ? entry.label() : entry.label
  return translate(`commandCenter.content.${entry.id.replace(':', '.')}`, fallback)
}
