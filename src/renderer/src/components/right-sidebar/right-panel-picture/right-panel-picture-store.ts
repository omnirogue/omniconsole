import { create } from 'zustand'

const PICTURE_KEY = 'omni.rightPanel.picture.v1'
const SHOWN_KEY = 'omni.rightPanel.pictureShown.v1'

// Why try/catch everywhere: storage can be full or blocked; the panel must still render.
function readItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeItem(key: string, value: string | null): boolean {
  try {
    if (value === null) {
      window.localStorage.removeItem(key)
    } else {
      window.localStorage.setItem(key, value)
    }
    return true
  } catch {
    return false
  }
}

type RightPanelPictureState = {
  /** The chosen picture as a data URL, kept on this device only. */
  picture: string | null
  /** Whether the right panel rests on the picture when no page is on screen. */
  shown: boolean
  /** False when this device could not keep the picture (for example storage is full). */
  setPicture: (picture: string) => boolean
  clearPicture: () => void
  setShown: (shown: boolean) => void
}

export const useRightPanelPicture = create<RightPanelPictureState>((set) => ({
  picture: readItem(PICTURE_KEY),
  shown: readItem(SHOWN_KEY) === '1',
  setPicture: (picture) => {
    if (!writeItem(PICTURE_KEY, picture)) {
      return false
    }
    set({ picture })
    return true
  },
  clearPicture: () => {
    writeItem(PICTURE_KEY, null)
    set({ picture: null })
  },
  setShown: (shown) => {
    writeItem(SHOWN_KEY, shown ? '1' : null)
    set({ shown })
  }
}))
