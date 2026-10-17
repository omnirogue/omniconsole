import { getAppearancePaneSearchEntries } from '@/components/settings/appearance-search'
import { getInputPaneSearchEntries } from '@/components/settings/input-search'
import { getNotificationsPaneSearchEntries } from '@/components/settings/notifications-search'
import { getShortcutsPaneSearchEntries } from '@/components/settings/shortcuts-search'
import { getStatsPaneSearchEntries } from '@/components/stats/stats-search'
import { translate } from '@/i18n/i18n'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'
import {
  BarChart3,
  Bell,
  Bot,
  Keyboard,
  MonitorSmartphone,
  Palette,
  Tags,
  TextCursorInput
} from 'lucide-react'
import type { SettingsNavigationBuildOptions } from './settings-navigation-build-options'

export function buildInterfaceSettingsSections({
  isMac,
  isWindows,
  isWebClient,
  managedBrowserCreationEnabled,
  mobileEmulatorCreationEnabled
}: SettingsNavigationBuildOptions): SettingsNavSection[] {
  const showDesktopOnlySettings = !isWebClient
  return [
    {
      id: 'session-tags',
      title: translate('sessionTags.title', 'Tags'),
      description: translate(
        'sessionTags.settingsDescription',
        'Organize sessions with your own names and colors.'
      ),
      icon: Tags,
      searchEntries: [
        {
          title: translate('sessionTags.title', 'Tags'),
          keywords: [
            translate('sessionTags.searchSession', 'session'),
            translate('sessionTags.searchColor', 'color'),
            translate('sessionTags.searchFilter', 'filter')
          ],
          targetSectionId: 'session-tags'
        }
      ],
      group: 'interface'
    },
    {
      id: 'session-steward',
      title: translate('sessionSteward.title', 'Session steward'),
      description: translate(
        'sessionSteward.settingsDescription',
        'What the app may do by itself to keep sessions moving and tidy.'
      ),
      icon: Bot,
      searchEntries: [
        {
          title: translate('sessionSteward.title', 'Session steward'),
          keywords: [
            translate('sessionSteward.searchArchive', 'archive'),
            translate('sessionSteward.searchNudge', 'nudge'),
            translate('sessionSteward.searchCleanup', 'cleanup'),
            translate('sessionSteward.searchWait', 'wait')
          ],
          targetSectionId: 'session-steward'
        }
      ],
      group: 'interface'
    },
    {
      id: 'session-hosts',
      title: translate('sessionHosts.title', 'Other computers'),
      description: translate(
        'sessionHosts.settingsDescription',
        'Controls between your computers, and where automatic actions may run.'
      ),
      icon: MonitorSmartphone,
      searchEntries: [
        {
          title: translate('sessionHosts.title', 'Other computers'),
          keywords: [
            translate('sessionHosts.searchRemote', 'remote'),
            translate('sessionHosts.searchSsh', 'ssh'),
            translate('sessionHosts.searchAutomation', 'automation'),
            translate('sessionHosts.searchFolder', 'folder')
          ],
          targetSectionId: 'session-hosts'
        }
      ],
      group: 'interface'
    },
    {
      id: 'appearance',
      title: translate('auto.hooks.useSettingsNavigationMetadata.93d88d20bf', 'Appearance'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.b11a5a48a2',
        'Theme, zoom, app and terminal appearance, sidebars, and status bar.'
      ),
      icon: Palette,
      searchEntries: getAppearancePaneSearchEntries({
        showWarpImport: showDesktopOnlySettings,
        showSystemTray: showDesktopOnlySettings && isWindows,
        showMenuBarIcon: showDesktopOnlySettings && isMac
      }),
      group: 'interface'
    },
    {
      id: 'input',
      title: translate('auto.hooks.useSettingsNavigationMetadata.0c6ee88a5f', 'Input & Editing'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.1f452cbd4c',
        'Selection and editing behavior.'
      ),
      icon: TextCursorInput,
      searchEntries: getInputPaneSearchEntries(),
      group: 'interface'
    },
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'notifications',
            title: translate(
              'auto.hooks.useSettingsNavigationMetadata.2eece16ad1',
              'Notifications'
            ),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.7682607591',
              'Native desktop notifications for agent and terminal events.'
            ),
            icon: Bell,
            searchEntries: getNotificationsPaneSearchEntries(),
            group: 'interface'
          }
        ]
      : []),
    {
      id: 'shortcuts',
      title: translate('auto.hooks.useSettingsNavigationMetadata.94295ebfb3', 'Shortcuts'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.dcd0d9b74f',
        'Keyboard shortcuts for common actions.'
      ),
      icon: Keyboard,
      searchEntries: getShortcutsPaneSearchEntries({
        includeManagedBrowser: managedBrowserCreationEnabled,
        includeMobileEmulator: mobileEmulatorCreationEnabled
      }),
      group: 'interface'
    },
    {
      id: 'stats',
      title: translate('auto.hooks.useSettingsNavigationMetadata.d72a58b5b9', 'Stats & Usage'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.b351014180',
        'OmniConsole stats plus Claude, Codex, OpenCode token analytics and Grok subscription usage.'
      ),
      icon: BarChart3,
      searchEntries: getStatsPaneSearchEntries(),
      group: 'interface'
    }
  ]
}
