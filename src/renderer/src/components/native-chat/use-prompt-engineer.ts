import { useRef, useState } from 'react'
import { promptEngineerChatInput, promptEngineerGoInput } from '../../../../shared/prompt-engineer'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'

type Mode = 'off' | 'drafting' | 'refined'
const modes = new Map<string, Mode>()

export function usePromptEngineer(paneKey: string) {
  const [mode, setMode] = useState<Mode>(() => modes.get(paneKey) ?? 'off')
  const sending = useRef(false)
  const [pending, setPending] = useState(false)
  const update = (next: Mode) => {
    setMode(next)
    if (next === 'off') {
      modes.delete(paneKey)
    } else {
      setBoundedScopeCacheEntry(modes, paneKey, next)
    }
  }
  return {
    pending,
    active: mode !== 'off',
    canGo: mode === 'refined',
    toggle: () => update(mode === 'off' ? 'drafting' : 'off'),
    send: async (
      draft: string,
      deliver: (text: string) => boolean | Promise<boolean>,
      go = false
    ) => {
      if (sending.current || (go && mode !== 'refined')) {
        return
      }
      sending.current = true
      setPending(true)
      try {
        const text = go
          ? promptEngineerGoInput(draft)
          : mode !== 'off'
            ? promptEngineerChatInput(draft)
            : draft
        if (await deliver(text)) {
          if (go) {
            update('off')
          } else if (mode !== 'off') {
            update('refined')
          }
        }
      } finally {
        sending.current = false
        setPending(false)
      }
    }
  }
}
