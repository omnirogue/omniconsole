/**
 * Redaction that keeps an AirTop live view's `token=<jwt>` whole, for the OmniOS question sync only.
 * The token controls that browser until it expires, so telemetry, error tracking and every other
 * request keep redacting it (`redactString`); the person needs the whole link to sign in.
 */

import { redactString, redactValue } from './redactor'

// Why bounded classes: the stash covers the link alone, never text around it (backticks, commas, prose).
const AIRTOP_LIVE_URL =
  /https:\/\/live\.airtop\.ai(?:\/[A-Za-z0-9._~-]+)+\/?(?:\?[A-Za-z0-9._~=&%+-]+)?/gi
const AIRTOP_TOKEN_PARAM =
  /[?&]token=eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?=&|$)/g
const PRIVATE_USE_FIRST = 0xe000
const PRIVATE_USE_LAST = 0xf8ff

/** A private-use character the input does not hold, so placeholders restore exactly. */
function freeMark(input: string): string | null {
  for (let code = PRIVATE_USE_FIRST; code <= PRIVATE_USE_LAST; code += 1) {
    const mark = String.fromCharCode(code)
    if (!input.includes(mark)) {
      return mark
    }
  }
  return null
}

/** `redactString`, except an AirTop live view's own token parameter. Idempotent like it. */
export function redactStringKeepingSignInLinks(input: string): string {
  if (typeof input !== 'string' || !/live\.airtop\.ai/i.test(input)) {
    return redactString(input)
  }
  const mark = freeMark(input)
  if (!mark) {
    return redactString(input)
  }
  const kept: string[] = []
  const stashed = input.replace(AIRTOP_LIVE_URL, (url) =>
    url.replace(AIRTOP_TOKEN_PARAM, (param) => `${mark}${kept.push(param) - 1}${mark}`)
  )
  if (kept.length === 0) {
    return redactString(input)
  }
  const placeholder = new RegExp(`${mark}(\\d+)${mark}`, 'g')
  return redactString(stashed).replace(placeholder, (_match, index) => kept[Number(index)] ?? '')
}

/** `redactValue` with sign-in links kept: only the OmniOS question sync may send them. */
export function redactValueKeepingSignInLinks(value: unknown): unknown {
  return redactValue(value, 'client', new WeakSet<object>(), redactStringKeepingSignInLinks)
}
