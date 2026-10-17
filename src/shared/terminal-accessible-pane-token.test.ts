import { describe, expect, it } from 'vitest'
import {
  decodeTerminalAccessiblePaneToken,
  encodeTerminalAccessiblePaneToken,
  terminalAccessiblePaneLabelSuffix
} from './terminal-accessible-pane-token'

const READER = /\(omni-terminal=([^\s)]+)\)/

describe('terminal accessible pane token', () => {
  it.each([
    'tab-a:11111111-1111-4111-8111-111111111111',
    'tab (1):11111111-1111-4111-8111-111111111111',
    "tab'!*:11111111-1111-4111-8111-111111111111"
  ])('survives the parenthesised accessibility name for %j', (paneKey) => {
    const token = READER.exec(terminalAccessiblePaneLabelSuffix(paneKey))?.[1]

    expect(decodeTerminalAccessiblePaneToken(token)).toBe(paneKey)
  })

  it('escapes the characters encodeURIComponent leaves in place', () => {
    expect(encodeTerminalAccessiblePaneToken("a(b)c!d'e*f")).toBe('a%28b%29c%21d%27e%2Af')
  })

  it('refuses a malformed token instead of throwing', () => {
    expect(decodeTerminalAccessiblePaneToken('%')).toBeNull()
    expect(decodeTerminalAccessiblePaneToken(undefined)).toBeNull()
  })
})
