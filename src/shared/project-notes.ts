import type { ProjectSettings } from './project-settings'
import type { SessionContextAttachment } from './session-context-attachments'

/**
 * The project's notes (upgrade plan PR 14): one attached Slite document where the coordinator
 * records decisions and facts a later session needs; threads only read it, like any document.
 * A record with several marks (an older computer's edit) keeps the first, never refused.
 */
export function projectNotesDocument(
  settings: Pick<ProjectSettings, 'attachments'>
): SessionContextAttachment | null {
  return settings.attachments.find((item) => item.kind === 'slite' && item.notes) ?? null
}

/** Marks one Slite attachment as the notes, or none with null; every other mark is cleared. */
export function withProjectNotes<T extends Pick<ProjectSettings, 'attachments'>>(
  settings: T,
  attachmentId: string | null
): T {
  return {
    ...settings,
    attachments: settings.attachments.map((item) => {
      const { notes: _notes, ...rest } = item
      return item.kind === 'slite' && item.id === attachmentId ? { ...rest, notes: true } : rest
    })
  }
}
