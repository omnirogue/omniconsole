import { create } from 'zustand'
import { personalViewStorageKey } from '@/lib/personal-view-storage'

export type QuietBackground = 'beach' | 'plain'
const KEY = 'omni.quiet-workspace.v1'
type Preference = { enabled: boolean; background: QuietBackground }
const DEFAULT: Preference = { enabled: false, background: 'beach' }

function read(): Preference {
  try {
    const value = JSON.parse(localStorage.getItem(personalViewStorageKey(KEY)) ?? 'null')
    return {
      enabled: value?.enabled === true,
      background: value?.background === 'plain' ? 'plain' : 'beach'
    }
  } catch {
    return DEFAULT
  }
}

export const useQuietWorkspace = create<
  Preference & {
    load: () => void
    toggle: () => void
    setBackground: (background: QuietBackground) => void
  }
>((set, get) => {
  const save = (preference: Preference) => {
    try {
      localStorage.setItem(personalViewStorageKey(KEY), JSON.stringify(preference))
    } catch {
      // Why: storage restrictions must not prevent taking a break from the output.
    }
    set(preference)
  }
  return {
    ...DEFAULT,
    load: () => set(read()),
    toggle: () => save({ enabled: !get().enabled, background: get().background }),
    setBackground: (background) => save({ enabled: get().enabled, background })
  }
})
