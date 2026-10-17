export const FAMILIES = [
  'Argon',
  'Astra',
  'Sol 6.1',
  'Terra',
  'Luna',
  'Opus',
  'Fable',
  'Sonnet',
  'Gemini 3.8 Flash',
  'Kimi',
  'Grok'
] as const
export type Family = (typeof FAMILIES)[number]

/** Match discovered IDs, never manufacture a provider/model ID from a display name. */
export function familyFor(id: string): Family | undefined {
  const model = id.toLowerCase().split('/').at(-1) ?? ''
  if (/^(?:gemini-4-)?argon(?:$|-)/.test(model)) {
    return 'Argon'
  }
  if (/^gpt-6(?:\.1)?-astra(?:$|-)/.test(model)) {
    return 'Astra'
  }
  if (/^gpt-6\.1-sol(?:$|-)/.test(model)) {
    return 'Sol 6.1'
  }
  if (/^gpt-(?:5\.6|6(?:\.1)?)-terra(?:$|-)/.test(model)) {
    return 'Terra'
  }
  if (/^gpt-6(?:\.1)?-luna(?:$|-)/.test(model)) {
    return 'Luna'
  }
  if (/^(?:claude-)?opus(?:$|-)/.test(model)) {
    return 'Opus'
  }
  if (/^(?:claude-)?fable(?:$|-)/.test(model)) {
    return 'Fable'
  }
  if (/^(?:claude-)?sonnet(?:$|-)/.test(model)) {
    return 'Sonnet'
  }
  if (/^gemini-3[.-]8-flash(?:$|-)/.test(model)) {
    return 'Gemini 3.8 Flash'
  }
  if (/^kimi(?:$|-)/.test(model)) {
    return 'Kimi'
  }
  if (/^grok(?:$|-)/.test(model)) {
    return 'Grok'
  }
  return undefined
}
