import { createHash } from 'node:crypto'
import { readWorkspaceWholeFile } from '../../workspace-whole-file'
import type { GraphVerifyRequest } from './graph-plan-types'

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength

export type VerifyEvidence = {
  code: Map<string, string>
  digests: Record<string, string>
  missing: Record<string, string>
}

export async function collectVerifyEvidence(
  request: GraphVerifyRequest,
  workspace: (() => Promise<string>) | undefined,
  read: typeof readWorkspaceWholeFile = readWorkspaceWholeFile
): Promise<VerifyEvidence> {
  const result: VerifyEvidence = { code: new Map(), digests: {}, missing: {} }
  const root = await workspace?.().catch(() => undefined)
  const files = new Map<string, Promise<string | null>>()
  for (const item of request.items) {
    let reason: string | undefined
    if (byteLength(request.scope) > 3000) {
      reason = 'scope-exceeds-evidence-limit'
    } else if (byteLength(item.title) > 400 || byteLength(item.detail) > 1500) {
      reason = 'report-exceeds-evidence-limit'
    } else if (!root || !item.file || !Number.isSafeInteger(item.line) || item.line! < 1) {
      reason = 'missing-code-location'
    }
    if (reason) {
      result.missing[item.key] = reason
      continue
    }
    const file = item.file!
    if (!files.has(file)) {
      files.set(
        file,
        read(root!, file).catch(() => null)
      )
    }
    const content = await files.get(file)!
    if (content === null) {
      result.missing[item.key] = 'unreadable-code'
      continue
    }
    const lines = content.split(/\r?\n/)
    if (item.line! > lines.length) {
      result.missing[item.key] = 'invalid-code-line'
      continue
    }
    const first = Math.max(1, item.line! - 40)
    const last = Math.min(lines.length, item.line! + 40)
    const selected = lines.slice(first - 1, last)
    const excerpt = selected.map((line, index) => `${first + index} | ${line}`).join('\n')
    if (selected.some((line) => line.length > 200) || byteLength(excerpt) > 4000) {
      result.missing[item.key] = 'code-exceeds-evidence-limit'
      continue
    }
    result.code.set(item.key, excerpt)
    result.digests[item.key] = createHash('sha256').update(content).digest('hex')
  }
  return result
}
