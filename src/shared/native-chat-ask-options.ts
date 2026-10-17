import type { AskOption } from './native-chat-ask-types'

/** Question options as the card renders them: bare strings or `{label, description, preview}`. */
export function parseAskOptions(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map((option): AskOption | null => {
      if (typeof option === 'string') {
        return { label: option }
      }
      if (
        option &&
        typeof option === 'object' &&
        typeof (option as { label?: unknown }).label === 'string'
      ) {
        const value = option as { label: string; description?: unknown; preview?: unknown }
        return {
          label: value.label,
          description: typeof value.description === 'string' ? value.description : undefined,
          ...(typeof value.preview === 'string' && value.preview.length > 0
            ? { preview: value.preview }
            : {})
        }
      }
      return null
    })
    .filter((option): option is AskOption => option !== null)
}
