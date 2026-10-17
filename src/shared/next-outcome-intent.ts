import { isWindowsAbsolutePathLike } from './cross-platform-path'

/** Conservative draft admission; semantic inference belongs to the current source agent. */
export type NextOutcomeIntent =
  | { kind: 'report' }
  | { kind: 'files'; targets: string[] }
  | { kind: 'needs-details'; reason: string }
  | { kind: 'unsupported'; reason: string }

const EXTERNAL_ACTION =
  /\b(publish|upload|release|re-release|deploy|send|email|refund|purchase|post|merge|push)\b/i
const EXTERNAL_DESTINATION = /https?:\/\/|\b(drive|youtube|dropbox|slack|s3|sharepoint)\b/i
// Sentence punctuation stays outside unquoted paths; quoted paths remain literal.
const FILE_PATH =
  '(?:`([^`]+)`|"([^"]+)"|\'([^\']+)\'|((?:[A-Za-z]:[\\\\/]|/|\\./|\\.\\./)[^\\s;,]+?))'
const SAVE_FILE = new RegExp(
  `^(?:save|write|update|create|export)(?: (?:the )?(?:result|report|file|output))?(?: (?:to|at|in))? ${FILE_PATH}[.!]?$`,
  'i'
)

export function nextOutcomeIntent(instructions: string): NextOutcomeIntent {
  const value = instructions.trim()
  if (EXTERNAL_ACTION.test(value) || EXTERNAL_DESTINATION.test(value)) {
    return {
      kind: 'unsupported',
      reason:
        'This finish needs an authorized action and an execution-host verifier for the actual destination. Bind it through the source agent with its existing target/receipt; a local result note cannot prove publication, release, delivery, or a linked-file update.'
    }
  }
  const clauses = value.split(/\s*;\s*|\s+and\s+(?=(?:save|write|update|create|export)\b)/i)
  const targets = clauses.map((clause) => {
    const match = SAVE_FILE.exec(clause)
    return match ? (match[1] ?? match[2] ?? match[3] ?? match[4]) : undefined
  })
  if (targets.every((target): target is string => Boolean(target))) {
    if (
      targets.some(
        (target) => !isWindowsAbsolutePathLike(target) && !/^(?:\/|\.\.?[\\/])/.test(target)
      )
    ) {
      return {
        kind: 'needs-details',
        reason: 'Use an explicit execution-host file path for the output destination.'
      }
    }
    return { kind: 'files', targets: [...new Set(targets)] }
  }
  if (
    !value ||
    /^(?:complete|deliver) the requested (?:outcome|result)\.?$/i.test(value) ||
    /^(?:write|return|provide) (?:a |the )?(?:(?:concise|final|review) )?(?:report|summary|findings)\.?$/i.test(
      value
    )
  ) {
    return { kind: 'report' }
  }
  return {
    kind: 'needs-details',
    reason:
      'Ask the current source agent to bind every requested result to a concrete file, Git target, or supported verification receipt. These instructions are retained; a generated report cannot stand in for an unspecified finish.'
  }
}

export function requireNextOutcomeIntent(
  instructions: string
): Extract<NextOutcomeIntent, { kind: 'files' | 'report' }> {
  const intent = nextOutcomeIntent(instructions)
  if (intent.kind === 'needs-details' || intent.kind === 'unsupported') {
    throw new Error(`${intent.kind}: ${intent.reason}`)
  }
  return intent
}
