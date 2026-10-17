/**
 * The paneKey that identifies a terminal pane travels inside the pane's accessibility
 * name as `(omni-terminal=<token>)`, and the reader parses it out of that parenthesised
 * suffix. encodeURIComponent leaves `!'()*` untouched, so the token is escaped further:
 * a stray parenthesis would truncate the parsed token and silently lose the pane.
 */
const EXTRA_ESCAPES = /[!'()*]/g

export function encodeTerminalAccessiblePaneToken(paneKey: string): string {
  return encodeURIComponent(paneKey).replace(
    EXTRA_ESCAPES,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

export function decodeTerminalAccessiblePaneToken(token: string | null | undefined): string | null {
  if (typeof token !== 'string') {
    return null
  }
  try {
    return decodeURIComponent(token)
  } catch {
    return null
  }
}

/** The suffix appended to the pane input's accessibility name. */
export function terminalAccessiblePaneLabelSuffix(paneKey: string): string {
  return ` (omni-terminal=${encodeTerminalAccessiblePaneToken(paneKey)})`
}
