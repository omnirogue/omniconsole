import { makePaneKey } from '../../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { notePersonTypingInConversation } from '@/components/next-steps/next-steps-person-typing'

/** A person's own terminal input (keys, paste, drop, quick command, dictation). */
export function recordTerminalUserInputForLeaf(tabId: string, leafId: string): void {
  try {
    const paneKey = makePaneKey(tabId, leafId)
    // Why: hibernation must see all user-authorized terminal writes, including
    // sends that bypass xterm.onData.
    useAppStore.getState().recordTerminalInput(paneKey)
    // Runtime and queue writes also mark hibernation activity; only this path is the person.
    notePersonTypingInConversation(paneKey)
  } catch {
    // Legacy/malformed layouts are ignored; hibernation remains conservative
    // when it cannot match live PTYs to stable pane keys.
  }
}
