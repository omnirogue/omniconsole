import { createContext, useContext } from 'react'
import { useAppStore } from '@/store'

export type OpenInPane = (url: string) => void

export const OpenInPaneContext = createContext<OpenInPane | null>(null)

export function useOpenInPaneHandler(): OpenInPane | null {
  const open = useContext(OpenInPaneContext)
  const enabled = useAppStore((state) => state.settings?.commandCenter === true)
  return enabled ? open : null
}

export function useOpenInPane(fallback: OpenInPane): OpenInPane {
  return useOpenInPaneHandler() ?? fallback
}
