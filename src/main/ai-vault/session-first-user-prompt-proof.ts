import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { wslGatedReadFile, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { parseCodexSessionContent } from './session-scanner-codex-parser'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'
import { parseClaudeSessionContent } from './session-scanner-primary-parsers'
import { parseJsonObject } from './session-scanner-values'
import type { ReadAiVaultFirstUserPromptArgs } from './session-first-user-prompt-read'

/**
 * A transcript's user prompts with why there are none, for callers that act on "nobody asked it
 * anything" (the steward's empty sessions). `read` means the whole local file was read, every line
 * parsed and the parser found a session; the UI reader (`readAiVaultFirstUserPrompt`) keeps its
 * null for every failure. `prompts`: the first prompt, the user turns the parser kept and any
 * prompt Claude recorded without a turn; `complete` is false when older turns fell out of view.
 */
export type AiVaultFirstUserPromptProof =
  | { read: true; prompts: string[]; complete: boolean }
  | {
      read: false
      why:
        | 'remote'
        | 'unsupported'
        | 'missing'
        | 'unreadable'
        | 'too-large'
        | 'corrupt'
        | 'unparsed'
    }

/** An empty session's transcript is a few KB; anything this big has been used. */
export const FIRST_USER_PROMPT_PROOF_MAX_BYTES = 4 * 1024 * 1024

const no = (why: Extract<AiVaultFirstUserPromptProof, { read: false }>['why']) =>
  ({ read: false, why }) as const

export async function proveAiVaultFirstUserPrompt(
  args: ReadAiVaultFirstUserPromptArgs
): Promise<AiVaultFirstUserPromptProof> {
  if ((args.executionHostId ?? LOCAL_EXECUTION_HOST_ID) !== LOCAL_EXECUTION_HOST_ID) {
    return no('remote')
  }
  if (args.agent !== 'claude' && args.agent !== 'codex') {
    return no('unsupported')
  }
  const filePath = args.filePath.trim()
  if (!filePath) {
    return no('missing')
  }
  let content: string
  let file: { path: string; mtimeMs: number; modifiedAt: string; sizeBytes: number }
  try {
    const info = await wslGatedStat(filePath, 'scan')
    if (!info.isFile()) {
      return no('unreadable')
    }
    if (info.size > FIRST_USER_PROMPT_PROOF_MAX_BYTES) {
      return no('too-large')
    }
    file = {
      path: filePath,
      mtimeMs: info.mtimeMs,
      modifiedAt: info.mtime.toISOString(),
      sizeBytes: info.size
    }
    content = await wslGatedReadFile(filePath, 'utf-8', 'scan')
  } catch (error) {
    return no((error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable')
  }
  const records: Record<string, unknown>[] = []
  for (const line of content.split(/\r?\n/)) {
    const record = line.trim() ? parseJsonObject(line) : null
    // Why: the parsers skip lines they cannot read, so a damaged file would read as unprompted.
    if (line.trim() && !record) {
      return no('corrupt')
    }
    if (record) {
      records.push(record)
    }
  }
  try {
    const session = await withFullFirstUserPromptCapture(() =>
      args.agent === 'claude'
        ? parseClaudeSessionContent(file, content)
        : parseCodexSessionContent({ file, content, codexHome: args.codexHome ?? null })
    )
    if (!session) {
      return no('unparsed')
    }
    const prompts = [
      session.firstUserPrompt,
      ...session.previewMessages.filter((m) => m.role === 'user').map((m) => m.text),
      ...(args.agent === 'claude' ? claudeUnsavedPrompts(records) : [])
    ].flatMap((text) => (text?.trim() ? [text.trim()] : []))
    return { read: true, prompts, complete: session.previewMessagesTruncated !== true }
  } catch {
    return no('unparsed')
  }
}

/** Prompts Claude recorded without saving a turn: typed (`last-prompt`) or queued. */
function claudeUnsavedPrompts(records: readonly Record<string, unknown>[]): string[] {
  return records.flatMap((record) => {
    const text =
      record.type === 'last-prompt'
        ? record.lastPrompt
        : record.type === 'queue-operation' && record.operation === 'enqueue'
          ? record.content
          : null
    return typeof text === 'string' ? [text] : []
  })
}
