import { Buffer } from 'node:buffer'

/**
 * Collects output up to a cap, so a chatty child cannot grow the heap.
 *
 * Accepts strings as well as buffers: a stream someone called `setEncoding` on
 * emits strings, and concatenating those as buffers throws inside a `data`
 * handler, where the rejection has nowhere to go and the caller just hangs.
 */
export function createOutputSink(
  maxBytes: number,
  capture: 'head' | 'tail' = 'head'
): {
  write: (chunk: Buffer | string) => void
  text: () => string
  truncated: () => boolean
} {
  const chunks: Buffer[] = []
  let bytes = 0
  let observedBytes = 0
  return {
    write(raw) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      observedBytes += chunk.length
      if (capture === 'tail') {
        if (maxBytes <= 0) {
          return
        }
        chunks.push(chunk)
        bytes += chunk.length
        while (bytes > maxBytes && chunks.length) {
          const first = chunks[0]
          const overflow = bytes - maxBytes
          if (overflow >= first.length) {
            chunks.shift()
            bytes -= first.length
          } else {
            chunks[0] = first.subarray(overflow)
            bytes -= overflow
          }
        }
        return
      }
      const remaining = maxBytes - bytes
      if (remaining <= 0) {
        return
      }
      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk)
      bytes += chunk.length
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    truncated: () => observedBytes > maxBytes
  }
}

export function readCapturedOutput(
  stdout: ReturnType<typeof createOutputSink>,
  stderr: ReturnType<typeof createOutputSink>
): { stdout: string; stderr: string; stdoutTruncated?: true; stderrTruncated?: true } {
  return {
    stdout: stdout.text(),
    stderr: stderr.text(),
    ...(stdout.truncated() ? { stdoutTruncated: true as const } : {}),
    ...(stderr.truncated() ? { stderrTruncated: true as const } : {})
  }
}
