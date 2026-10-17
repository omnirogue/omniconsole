import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { RuntimeClientError } from './runtime/types'

export type TextInputFileOptions = {
  /** Names the input in the TTY refusal, e.g. `body` or `brief`. */
  label?: string
  /** Refuses text over this many UTF-8 bytes; stdin stops being read once it is exceeded. */
  maxBytes?: number
  tooLargeMessage?: string
}

/** Reads `<path>` relative to the invocation cwd, or stdin for `-` (never an interactive TTY). */
export async function readTextInputFile(
  path: string,
  cwd: string,
  options: TextInputFileOptions = {}
): Promise<string> {
  const text =
    path === '-'
      ? await readStdinText(options)
      : await readFile(resolveInputPath(path, cwd), 'utf8')
  assertWithinLimit(Buffer.byteLength(text, 'utf8'), options)
  return text
}

function resolveInputPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path)
}

async function readStdinText(options: TextInputFileOptions): Promise<string> {
  if (process.stdin.isTTY) {
    throw new RuntimeClientError(
      'invalid_argument',
      `stdin ${options.label ?? 'input'} requested but stdin is a TTY`
    )
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    chunks.push(buffer)
    bytes += buffer.length
    assertWithinLimit(bytes, options)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function assertWithinLimit(bytes: number, options: TextInputFileOptions): void {
  if (options.maxBytes !== undefined && bytes > options.maxBytes) {
    throw new RuntimeClientError(
      'invalid_argument',
      options.tooLargeMessage ??
        `The ${options.label ?? 'input'} is over ${options.maxBytes} bytes.`
    )
  }
}
