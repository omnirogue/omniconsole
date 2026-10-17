import { useAppStore } from '@/store'
import { useSessionGrid } from '@/store/session-grid'
import { openCommandCenter } from './command-center-navigation'

/** Shows the Grid view. Kept apart from session-grid-actions so nav entries stay light. */
export function openSessionGrid(): void {
  useSessionGrid.getState().load(useAppStore.getState().settings?.commandCenter === true)
  openCommandCenter(useAppStore.getState())
}
