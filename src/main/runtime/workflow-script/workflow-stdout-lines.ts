import { StringDecoder } from 'node:string_decoder'
import type { ProcessResult } from '../../../shared/child-process/process-spec'

/**
 * Splits streamed stdout into complete lines for the live view and for the stored receipt. A line
 * the filter returns unchanged is stored byte for byte, so unfiltered output round-trips exactly.
 * The stored copy has its own cap; overflow is reported as truncation and the parser rejects it.
 */
export function createWorkflowStdoutLines(options: {
  maxBytes: number
  storeLine?: (line: string) => string | null
  onLine?: (line: string) => void
}): {
  write: (chunk: Buffer | string) => void
  result: (captured: ProcessResult) => ProcessResult
} {
  const decoder = new StringDecoder('utf8')
  const stored: string[] = []
  let storedBytes = 0
  let truncated = false
  let pending = ''
  const keep = (text: string) => {
    const bytes = Buffer.byteLength(text)
    if (truncated || storedBytes + bytes > options.maxBytes) {
      truncated = true
      return
    }
    stored.push(text)
    storedBytes += bytes
  }
  const line = (text: string, terminated: boolean) => {
    try {
      options.onLine?.(text)
    } catch {
      /* Live view only. */
    }
    let kept: string | null
    try {
      kept = options.storeLine ? options.storeLine(text) : text
    } catch {
      kept = text
    }
    if (kept !== null) {
      keep(terminated ? `${kept}\n` : kept)
    }
  }
  const consume = (text: string) => {
    let start = 0
    let index = text.indexOf('\n')
    while (index !== -1) {
      line(pending + text.slice(start, index), true)
      pending = ''
      start = index + 1
      index = text.indexOf('\n', start)
    }
    pending += text.slice(start)
  }
  return {
    write: (chunk) => consume(typeof chunk === 'string' ? chunk : decoder.write(chunk)),
    result: (captured) => {
      consume(decoder.end())
      if (pending) {
        line(pending, false)
        pending = ''
      }
      // The raw capture's own cap no longer applies: every line was seen through onStdout.
      return {
        code: captured.code,
        signal: captured.signal,
        stdout: stored.join(''),
        stderr: captured.stderr,
        timedOut: captured.timedOut,
        ...(truncated ? { stdoutTruncated: true as const } : {}),
        ...(captured.stderrTruncated ? { stderrTruncated: true as const } : {})
      }
    }
  }
}
