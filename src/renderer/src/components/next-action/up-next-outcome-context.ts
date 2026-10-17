import { createContext } from 'react'

/** Connects a Verify output to the mounted Outcome head's existing checklist. */
export const UpNextOutcomeContext = createContext<string | null>(null)
