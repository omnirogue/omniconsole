import { sha256 } from './sha256'
import {
  BRIEF_LIST_SECTIONS,
  type BriefContent,
  type BriefOriginalRequest
} from './assisted-brief-types'

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

function digest(text: string): Uint8Array {
  return sha256(new TextEncoder().encode(text))
}

export type BriefHashContext = {
  workspaceKey: string
  original: BriefOriginalRequest
  namedModels: readonly string[]
}

/**
 * Everything that reaches the execution prompt, in a fixed order. Item ids are UI identities,
 * so they are left out: the hash changes only when what the person approves changes.
 */
export function canonicalBriefJson(content: BriefContent, context: BriefHashContext): string {
  return JSON.stringify([
    'assisted-brief/v1',
    context.workspaceKey,
    context.original.text,
    context.original.attachments.map((file) => [file.name, file.path]),
    [...context.namedModels],
    [content.outcome.origin, content.outcome.text],
    BRIEF_LIST_SECTIONS.map((section) => [
      section,
      content.sections[section].map((item) => [item.origin, item.text])
    ]),
    content.questions.map((question) => [question.prompt, question.choices, question.section])
  ])
}

export function computeBriefContentHash(content: BriefContent, context: BriefHashContext): string {
  return `sha256:${toHex(digest(canonicalBriefJson(content, context)))}`
}

/** A v4-shaped UUID derived from the operation, so tab-id and pane-key validators accept it. */
function uuidFromDigest(bytes: Uint8Array): string {
  const b = Array.from(bytes.slice(0, 16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = toHex(Uint8Array.from(b))
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * The start identity for one approved revision. Deterministic, so a double click, a retry
 * or a restart after a lost write all derive the same operation and the same tab id.
 */
export function deriveBriefStartIdentity(
  briefId: string,
  revision: number,
  contentHash: string
): { operationId: string; tabId: string } {
  const hashPart = contentHash.replace(/^sha256:/, '').slice(0, 16)
  const operationId = `brief-start-${briefId}-r${revision}-${hashPart}`
  return { operationId, tabId: uuidFromDigest(digest(operationId)) }
}
