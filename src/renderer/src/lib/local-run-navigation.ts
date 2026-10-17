import { create } from 'zustand'
import { useAppStore } from '@/store'

/**
 * Where the canvas was opened from. A workspace row asks for a graph on ITS folder;
 * the Local runs page opens with nothing pre-selected. Nothing here is restored
 * across restarts: a navigation intent is not saved work.
 */
export const useLocalRunNavigation = create<{
  open: boolean
  /** Folder path the person asked to run a graph on, when they came from a workspace. */
  workspacePath: string | null
  /** Changes on every request, so an already-open page can react to a new one. */
  requestedAt: number
  show: (workspacePath?: string) => void
  clear: () => void
}>((set) => ({
  open: false,
  workspacePath: null,
  requestedAt: 0,
  show: (workspacePath) =>
    set({ open: true, workspacePath: workspacePath ?? null, requestedAt: Date.now() }),
  clear: () => set({ open: false, workspacePath: null })
}))

/**
 * Open the canvas on one workspace FOLDER, from anywhere a workspace is shown: the Local
 * runs page is its own door, and the section is asked for a graph on this folder.
 */
export function openLocalRunCanvasForWorkspace(workspacePath: string): void {
  useLocalRunNavigation.getState().show(workspacePath)
  useAppStore.getState().openLocalRunsPage()
}
