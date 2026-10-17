import { useId } from 'react'
import { translate } from '@/i18n/i18n'
import type { SessionContextAttachment } from '../../../../shared/session-context-attachments'
import { projectNotesDocument, withProjectNotes } from '../../../../shared/project-notes'

const NONE = ''

/** Picks which attached Slite document is the project's notes; hidden until one is attached. */
export function ProjectSettingsNotes({
  attachments,
  onChange
}: {
  attachments: SessionContextAttachment[]
  onChange: (attachments: SessionContextAttachment[]) => void
}): React.JSX.Element | null {
  const name = useId()
  const documents = attachments.filter((item) => item.kind === 'slite')
  if (documents.length === 0) {
    return null
  }
  const chosen = projectNotesDocument({ attachments })?.id ?? NONE
  const options = [
    { id: NONE, label: translate('projects.settings.notesNone', 'None') },
    ...documents.map((item) => ({ id: item.id, label: item.title }))
  ]
  return (
    <fieldset className="space-y-2" data-project-settings-notes="">
      <legend className="text-xs font-medium">
        {translate('projects.settings.notes', 'Project notes')}
      </legend>
      <div className="flex flex-wrap gap-3">
        {options.map((option) => (
          <label key={option.id} className="flex min-w-0 items-center gap-1.5 text-xs">
            <input
              type="radio"
              name={name}
              value={option.id}
              checked={chosen === option.id}
              onChange={() =>
                onChange(withProjectNotes({ attachments }, option.id || null).attachments)
              }
              className="accent-primary"
            />
            <span className="min-w-0 truncate">{option.label}</span>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'projects.settings.notesHelp',
          'The project chat records decisions and facts in this Slite document. Threads read it like any attachment.'
        )}
      </p>
    </fieldset>
  )
}
