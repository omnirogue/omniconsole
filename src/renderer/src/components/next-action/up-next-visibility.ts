import { createContext } from 'react'

/** Hidden conversation panels retain edits, but need no background Up next reads. */
export const UpNextVisibilityContext = createContext(true)
