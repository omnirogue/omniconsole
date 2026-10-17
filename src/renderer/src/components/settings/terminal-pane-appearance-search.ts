import { getTerminalClipboardSearchEntries } from './terminal-clipboard-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getTerminalPaneAppearanceSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.search.72bbcbd1dd',
      'Inactive Pane Opacity'
    ),
    description: translate(
      'auto.components.settings.terminal.search.18dd5026c6',
      'Opacity applied to panes that are not currently active.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.846a7a1204', 'pane'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.46d99ef4bb', 'opacity'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.6c4c85ba43', 'dimming')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.2d5ab88b7c', 'Divider Thickness'),
    description: translate(
      'auto.components.settings.terminal.search.e58d4040d0',
      'Thickness of the pane divider line.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.846a7a1204', 'pane'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.781f49d942', 'divider'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.f637a7dee9', 'thickness')
    ]
  }
])

export const getTerminalPaneInteractionSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.search.archiveSleeps.title',
      'Archive puts idle agents to sleep'
    ),
    description: translate(
      'auto.components.settings.terminal.search.archiveSleeps.description',
      'Archiving a conversation stops its idle agent; opening it resumes. Archives by the CLI, agents or sync wait 30 idle minutes out of view.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.archiveSleeps.archive',
        'archive'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.archiveSleeps.sleep',
        'sleep'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.archiveSleeps.pause',
        'pause'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.archiveSleeps.idle',
        'idle'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.terminal.search.autoContinue.title',
      'Auto-continue interrupted sessions'
    ),
    description: translate(
      'auto.components.settings.terminal.search.autoContinue.description',
      'Continue work interrupted by an app restart, upgrade, or reboot after the resumed agent is ready.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.autoContinue.restart',
        'restart'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.autoContinue.resume',
        'resume'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.autoContinue.upgrade',
        'upgrade'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.autoContinue.reboot',
        'reboot'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.autoContinue.continue',
        'continue'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.terminal.search.restoreFloodGuard.title',
      'Resume slept agents only when opened'
    ),
    description: translate(
      'auto.components.settings.terminal.search.restoreFloodGuard.description',
      'A finished, slept or archived agent resumes when you open its tab, never from a background mount. Agents that were mid-task still continue on their own, and no session is resumed as a second copy.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.restoreFlood.restore',
        'restore'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.restoreFlood.flood',
        'flood'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.restoreFlood.agent',
        'agent'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.terminal.search.launchAdmission.title',
      'Agent starts per 10 seconds'
    ),
    description: translate(
      'auto.components.settings.terminal.search.launchAdmission.description',
      'At most this many agents start in any 10 seconds; the rest wait their turn, and a tab you open goes first. 0 means no limit, as does turning off Resume slept agents only when opened.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.launchAdmission.limit',
        'limit'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.launchAdmission.queue',
        'queue'
      )
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.scrollSpeed.title', 'Scroll Speed'),
    description: translate(
      'auto.components.settings.terminal.search.scrollSpeed.description',
      'Tune normal terminal scrollback, fast modifier scrolling, and full-screen TUI wheel speed.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.39ea7c0d28', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.scroll', 'scroll'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.scrolling', 'scrolling'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.speed', 'speed'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.wheel', 'wheel'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.ea364ce6e4', 'mouse'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.trackpad', 'trackpad'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.tui', 'tui')
    ]
  },
  {
    title: translate(
      'auto.components.settings.terminal.search.ask_before_closing_running_terminals_title',
      'Ask Before Closing Running Terminals'
    ),
    description: translate(
      'auto.components.settings.terminal.search.ask_before_closing_running_terminals_description',
      'Show a confirmation before closing a terminal that has a running command or agent.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.10f9fb6fea', 'settings'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.a0c44061ee', 'confirm'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.close_terminal', 'close'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.39ea7c0d28', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.running', 'running'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.command', 'command'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.agent', 'agent'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.process', 'process'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.prompt', 'prompt'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.stop', 'stop')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.c6178a2b4d', 'Focus Follows Mouse'),
    description: translate(
      'auto.components.settings.terminal.search.17cc3ea102',
      "Hovering a terminal pane activates it without needing to click. Mirrors Ghostty's focus-follows-mouse setting. Selections and window switching stay safe."
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f5d1e3d472', 'focus'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.b5116e7b12', 'follows'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.ea364ce6e4', 'mouse'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.d1fa00a9cb', 'hover'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.846a7a1204', 'pane'),
      // Why: product name stays untranslated so search matches "Ghostty".
      'Ghostty',
      'ghostty',
      ...translateSearchKeyword('auto.components.settings.terminal.search.f036794286', 'active')
    ]
  },
  ...getTerminalClipboardSearchEntries()
])
