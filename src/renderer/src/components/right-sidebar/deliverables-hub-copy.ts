import { translate } from '@/i18n/i18n'

/** The Deliverables Hub panel's words; kept apart so the panel stays short. */
export function deliverablesHubCopy() {
  return {
    launched: translate(
      'auto.components.rightSidebar.deliverables.launched',
      'Code Builder launched in a new worktree.'
    ),
    subtitle: translate(
      'auto.components.rightSidebar.deliverables.subtitle',
      'Markdown plans on this computer'
    ),
    searchPlaceholder: translate(
      'auto.components.rightSidebar.deliverables.searchPlaceholder',
      'Search titles and contents'
    ),
    search: translate('auto.components.rightSidebar.deliverables.search', 'Search deliverables'),
    refresh: translate('auto.components.rightSidebar.deliverables.refresh', 'Refresh deliverables'),
    repository: translate(
      'auto.components.rightSidebar.deliverables.repository',
      'Code Builder repository'
    ),
    chooseRepository: translate(
      'auto.components.rightSidebar.deliverables.chooseRepository',
      'Choose build repository'
    ),
    loading: translate('auto.components.rightSidebar.deliverables.loading', 'Loading Plans…'),
    desktopOnly: translate(
      'auto.components.rightSidebar.deliverables.desktopOnly',
      'Available in the desktop app.'
    ),
    empty: translate(
      'auto.components.rightSidebar.deliverables.empty',
      'No matching Markdown plans.'
    ),
    open: translate('auto.components.rightSidebar.deliverables.open', 'Open'),
    chooseFirst: translate(
      'auto.components.rightSidebar.deliverables.chooseFirst',
      'Choose a build repository'
    ),
    launching: translate('auto.components.rightSidebar.deliverables.launching', 'Launching…'),
    launch: translate(
      'auto.components.rightSidebar.deliverables.launch',
      'Launch Code Builder in Worktree'
    ),
    summary: (total: number, root: string) =>
      translate(
        'auto.components.rightSidebar.deliverables.summary',
        '{{total}} deliverables · {{root}}',
        { total, root }
      ),
    skipped: (skipped: number) =>
      translate('auto.components.rightSidebar.deliverables.skipped', '{{skipped}} files skipped', {
        skipped
      }),
    launchIn: (repo: string) =>
      translate('auto.components.rightSidebar.deliverables.launchIn', 'Launch Codex in {{repo}}', {
        repo
      })
  }
}
