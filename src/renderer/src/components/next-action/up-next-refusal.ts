import { translate } from '@/i18n/i18n'
import {
  UP_NEXT_REASON_KEYS,
  UP_NEXT_REFUSAL_KEYS,
  UP_NEXT_WRITE_UNAVAILABLE
} from '../../../../shared/up-next-types'

/**
 * The rule the host STATED, when it stated one.
 *
 * The engine speaks in two catalogs and throws both as the error's message: the ordering
 * refusals (`upNext.refusal.*`) and the reasons an add is off (`upNext.addDisabled.*`,
 * e.g. a finished session). Reading only one of them is why a refused write could reach a
 * person as the generic "could not be made on this host", or as a raw catalog key in a
 * terminal pane.
 */
export function upNextStatedRuleKey(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error)
  const stated = [
    ...Object.values(UP_NEXT_REFUSAL_KEYS),
    ...Object.values(UP_NEXT_REASON_KEYS)
  ] as string[]
  return stated.includes(message) ? message : null
}

/** A bare `word.word` shape — a catalog key, never a sentence a host would write. */
const RAW_KEY_SHAPE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/

/**
 * The sentence a failure carries when it is safe to show as-is: the engine also throws
 * host-authored sentences on paths that state no catalog rule (measured live: "This
 * outcome has an in-flight or unverifiable action. Reconcile its receipt before editing."
 * arrived as the generic banner instead). Null for anything that is not safe to show
 * verbatim — empty/missing messages, and a raw key from either catalog this renderer has
 * no mapping for, which must never reach a person as literal text.
 */
export function upNextUnmappedMessage(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null
  }
  const message = error.message.trim()
  if (!message) {
    return null
  }
  if (message.startsWith('upNext.') || RAW_KEY_SHAPE.test(message)) {
    return null
  }
  return message
}

export function upNextRefusal(error: unknown): string {
  const stated = upNextStatedRuleKey(error)
  if (stated) {
    return translate(stated, '')
  }
  return (
    upNextUnmappedMessage(error) ?? translate('upNext.writeUnavailable', UP_NEXT_WRITE_UNAVAILABLE)
  )
}

/**
 * A diagnostic the host recorded, for Details: a refusal it recorded is a catalog key and is said
 * in the UI's language; any other text is the host's own sentence and is shown as it is.
 */
export function upNextDiagnosticText(text: string): string {
  const stated = upNextStatedRuleKey(text)
  return stated ? translate(stated, text) : text
}
