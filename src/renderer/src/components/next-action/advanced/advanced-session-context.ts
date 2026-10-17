import { createContext, useContext } from 'react'
import type { SidebarSession } from '@/lib/sidebar-sessions'

export const AdvancedSessionContext = createContext<SidebarSession | null>(null)
export const useAdvancedSession = () => useContext(AdvancedSessionContext)
