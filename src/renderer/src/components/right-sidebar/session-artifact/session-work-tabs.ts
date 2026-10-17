import { translate } from '@/i18n/i18n'

/** The Session work tabs, in the one order every session and every provider shows them. */
export const SESSION_WORK_TABS = ['omnios', 'plan', 'files', 'work-log', 'next-steps'] as const
export type SessionWorkTab = (typeof SESSION_WORK_TABS)[number]

/** What the on-screen session actually has; a tab with nothing real behind it is not drawn. */
export type SessionWorkCounts = {
  pages: number
  plans: number
  files: number
  /** The session has an agent row whose progress can be read. */
  workLog: boolean
  nextSteps: number
}

function hasContent(tab: SessionWorkTab, counts: SessionWorkCounts): boolean {
  switch (tab) {
    case 'omnios':
      return counts.pages > 0
    case 'plan':
      return counts.plans > 0
    case 'files':
      return counts.files > 0
    case 'work-log':
      return counts.workLog
    case 'next-steps':
      return counts.nextSteps > 0
  }
}

/** Tabs with content, plus one a person explicitly asked for (e.g. "Open in panel"). */
export function availableSessionWorkTabs(
  counts: SessionWorkCounts,
  requested: SessionWorkTab | null
): SessionWorkTab[] {
  return SESSION_WORK_TABS.filter((tab) => tab === requested || hasContent(tab, counts))
}

/** The person's pick while it still has content, else the first tab that does. */
export function resolveSessionWorkTab(
  available: readonly SessionWorkTab[],
  picked: SessionWorkTab | null
): SessionWorkTab | null {
  if (picked && available.includes(picked)) {
    return picked
  }
  return available[0] ?? null
}

export function sessionWorkTabLabel(tab: SessionWorkTab): string {
  switch (tab) {
    case 'omnios':
      return translate('sessionPanel.tab.omnios', 'OmniOS')
    case 'plan':
      return translate('sessionPanel.tab.plan', 'Plan')
    case 'files':
      return translate('sessionPanel.tab.files', 'Files & links')
    case 'work-log':
      return translate('sessionPanel.tab.workLog', 'Work log')
    case 'next-steps':
      return translate('sessionPanel.nextSteps', 'Next steps')
  }
}
