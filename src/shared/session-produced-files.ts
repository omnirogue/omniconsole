// Files a session made with commands rather than file tools: an ffmpeg render, a generated image
// saved by a script, a download. Read from the command line and the tool's own output, only for
// file types a person opens (images, video, audio, pages, documents); the panel then keeps only
// paths that exist. Cached per message, like the other transcript reads.

import { classifySessionFile } from './session-file-kind'
import type { NativeChatMessage } from './native-chat-types'

const SHELL_TOOLS = /^(bash|shell|exec_command|local_shell|powershell|run_command)$/i
/** `-o x`, `--output x`, `--output=x`, `--out x`, and shell redirects `> x`, `>> x`. */
const OUTPUT_FLAG =
  /(?:^|\s)(?:-o|--output|--out|--outfile|--output-file)(?:=|\s+)(['"]?)([^\s'"]+)\1/g
const REDIRECT = /(?:^|[^0-9&])>>?\s*(['"]?)([^\s'"&|;]+)\1/g
/** Commands whose last argument is where they write. Not curl/wget/yt-dlp: theirs is the source. */
const LAST_ARG_WRITERS = /^(ffmpeg|cp|mv|convert|magick|sips)$/
/** "Saved to /x/y.png", "Wrote: /x/y.mp4", "output: /x/y.pdf" in a tool's own output. */
const REPORTED_PATH =
  /\b(?:saved|wrote|written|created|exported|rendered|generated|downloaded|output)\b[^\n/\\]{0,40}?((?:\/|[A-Za-z]:\\)[^\s'"`<>|]+)/gi

function isPersonFile(path: string): boolean {
  return (
    classifySessionFile(path) !== 'other' &&
    !path.startsWith('/dev/') &&
    !/^[a-z][a-z0-9+.-]*:\/\//i.test(path)
  )
}

const SHELL_WRAPPERS = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh$/

function argvText(argv: unknown[]): string {
  const parts = argv.filter((part): part is string => typeof part === 'string')
  // Why: Codex runs `["bash", "-lc", "<script>"]`; the script is the command that writes.
  if (parts.length >= 3 && SHELL_WRAPPERS.test(parts[0]!) && /^-l?c$/.test(parts[1]!)) {
    return parts.at(-1)!
  }
  return parts.join(' ')
}

/** The command line inside a shell tool's input: Claude `{command}`, Codex `{cmd}` or argv. */
export function commandText(input: unknown): string {
  let value = input
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return value
    }
    try {
      value = JSON.parse(trimmed)
    } catch {
      return value as string
    }
  }
  if (Array.isArray(value)) {
    return argvText(value)
  }
  const fields = (value ?? {}) as Record<string, unknown>
  const command = fields.command ?? fields.cmd
  if (Array.isArray(command)) {
    return argvText(command)
  }
  return typeof command === 'string' ? command : ''
}

function lastArgument(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean)
  const program = tokens[0]?.split('/').pop() ?? ''
  if (!LAST_ARG_WRITERS.test(program) || tokens.length < 3) {
    return null
  }
  return tokens.at(-1)?.replace(/^['"]|['"]$/g, '') ?? null
}

/** The files one shell command line says it writes. */
export function commandOutputPaths(command: string): string[] {
  const paths: string[] = []
  for (const match of command.matchAll(OUTPUT_FLAG)) {
    paths.push(match[2]!)
  }
  for (const match of command.matchAll(REDIRECT)) {
    paths.push(match[2]!)
  }
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const last = lastArgument(segment)
    if (last) {
      paths.push(last)
    }
  }
  return [...new Set(paths)].filter(isPersonFile)
}

/** The absolute paths a tool's output reports writing. */
export function reportedOutputPaths(output: string): string[] {
  const scanned = output.length > 100_000 ? output.slice(0, 100_000) : output
  return [...scanned.matchAll(REPORTED_PATH)]
    .map((match) => match[1]!.replace(/[.,;:)\]]+$/, ''))
    .filter(isPersonFile)
}

const pathsByMessage = new WeakMap<NativeChatMessage, string[]>()

function producedInMessage(message: NativeChatMessage): string[] {
  const cached = pathsByMessage.get(message)
  if (cached) {
    return cached
  }
  const paths: string[] = []
  for (const block of message.blocks) {
    if (block.type === 'tool-call' && SHELL_TOOLS.test(block.name)) {
      paths.push(...commandOutputPaths(commandText(block.input)))
    } else if (block.type === 'tool-result' && !block.isError) {
      paths.push(...reportedOutputPaths(block.output))
    }
  }
  pathsByMessage.set(message, paths)
  return paths
}

/** Files the session's commands produced, each with the latest message that named it. */
export function conversationProducedFileEntries(
  messages: readonly NativeChatMessage[]
): { path: string; messageIndex: number }[] {
  const byPath = new Map<string, number>()
  messages.forEach((message, messageIndex) => {
    if (message.role === 'user') {
      return
    }
    for (const path of producedInMessage(message)) {
      byPath.delete(path)
      byPath.set(path, messageIndex)
    }
  })
  return [...byPath].map(([path, messageIndex]) => ({ path, messageIndex }))
}
