import React from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ProjectSettings } from '../../../../shared/project-settings'
import { openProjectSettings } from './project-settings-dialog-store'

function Chip({ label, count }: { label: string; count: number }): React.JSX.Element | null {
  if (count === 0) {
    return null
  }
  return (
    <span
      className="rounded-full border bg-card px-2 py-px text-[11px] text-muted-foreground"
      data-session-project-context-chip={label}
    >
      {label} <span className="tabular-nums font-semibold text-foreground">{count}</span>
    </span>
  )
}

/** What every thread of this project inherits, counted, with the way to change it. */
export function SessionProjectContextChips({
  folderId,
  settings
}: {
  folderId: string
  settings: ProjectSettings | null
}): React.JSX.Element {
  if (!settings) {
    return (
      <p
        className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground"
        data-session-project-context="none"
      >
        {translate(
          'projects.page.notSetUp',
          'This folder is not set up as a project yet: its threads inherit nothing.'
        )}
        <Button size="xs" variant="outline" onClick={() => openProjectSettings(folderId)}>
          {translate('projects.page.setUp', 'Set up')}
        </Button>
      </p>
    )
  }
  const kinds = settings.attachments.reduce<Record<string, number>>((counts, item) => {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1
    return counts
  }, {})
  const computers = Array.isArray(settings.hostPolicy) ? settings.hostPolicy.length : 0
  return (
    <section
      className="flex flex-wrap items-center gap-1.5"
      data-session-project-context="settings"
      aria-label={translate('projects.page.context', 'Project context')}
    >
      <Chip label={translate('projects.page.chipRepos', 'Repos')} count={settings.repos.length} />
      <Chip label={translate('projects.page.chipFiles', 'Files')} count={kinds.file ?? 0} />
      <Chip label={translate('projects.page.chipFolders', 'Folders')} count={kinds.folder ?? 0} />
      <Chip label={translate('projects.page.chipSlite', 'Slite')} count={kinds.slite ?? 0} />
      <Chip label={translate('projects.page.chipOmnios', 'OmniOS')} count={kinds.omnios ?? 0} />
      <Chip label={translate('projects.page.chipSkills', 'Skills')} count={kinds.skill ?? 0} />
      <Chip
        label={translate('projects.page.chipInstructions', 'Instructions')}
        count={kinds.instructions ?? 0}
      />
      <Chip
        label={translate('projects.page.chipAgents', 'Agents')}
        count={settings.agents.length}
      />
      <Chip label={translate('projects.page.chipComputers', 'Computers')} count={computers} />
      {settings.repos.length + settings.attachments.length + settings.agents.length === 0 ? (
        <span className="text-xs text-muted-foreground">
          {translate('projects.page.contextEmpty', 'Nothing attached yet.')}
        </span>
      ) : null}
    </section>
  )
}
