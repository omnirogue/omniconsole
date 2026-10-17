import { create } from 'zustand'

/** Which project folder's settings dialog is open, or the create dialog; one for the whole app. */
export const useProjectSettingsDialog = create<{ folderId: string | null; create: boolean }>(
  () => ({ folderId: null, create: false })
)

export function openProjectSettings(folderId: string): void {
  useProjectSettingsDialog.setState({ folderId, create: false })
}

/** New project: a name, a place and its settings, saved together. */
export function openProjectCreate(): void {
  useProjectSettingsDialog.setState({ folderId: null, create: true })
}

export function closeProjectSettings(): void {
  useProjectSettingsDialog.setState({ folderId: null, create: false })
}
