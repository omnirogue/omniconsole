import { stripScrollbackAnsi } from './native-chat-scrape-fallback'

export function ompModelSwitchOutcome(
  buffer: string,
  modelId: string
): 'applied' | 'rejected' | undefined {
  const text = stripScrollbackAnsi(buffer).replace(/\s+/g, '')
  // The terminal's provider-qualified confirmation excludes prompt echoes and similar ids.
  if (text.includes(`Session-onlymodel:${modelId}.`)) {
    return 'applied'
  }
  if (text.includes(`Unknownmodel:${modelId}`)) {
    return 'rejected'
  }
  return undefined
}
