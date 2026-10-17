import { spawnSync as nodeSpawnSync } from 'node:child_process'
import type { ResolvedSpawn } from './run-process'
import type { ProcessSpec, ProcessResult } from './process-spec'
import { DEFAULT_PROCESS_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES } from './process-spec'

export function executeResolvedProcessSync(
  spec: ProcessSpec,
  resolved: ResolvedSpawn
): ProcessResult {
  if (spec.onSpawn) {
    throw new Error('Spawn observation requires asynchronous runProcess.')
  }
  if (spec.outputCapture === 'tail') {
    throw new Error('Tail capture requires asynchronous runProcess.')
  }
  const result = nodeSpawnSync(resolved.file, [...resolved.args], {
    ...resolved.options,
    // resolveSpawn already sets this, but the Windows-console guard reads call
    // sites textually and cannot see through the spread. Stating it here keeps
    // the file scanned instead of allowlisted, which would unguard all of it.
    windowsHide: true,
    input: spec.input,
    timeout: spec.timeoutMs === null ? undefined : (spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS),
    maxBuffer: spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    encoding: 'buffer'
  })
  if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') {
    throw result.error
  }
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout?.toString('utf8') ?? '',
    stderr: result.stderr?.toString('utf8') ?? '',
    // Why ETIMEDOUT and not the signal: a timeout kills with SIGTERM, but so
    // does anything else that terminates the child, and only a timeout also
    // sets this error. Reading the signal alone reports a deliberately
    // stopped process as having timed out, which callers retry.
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  }
}
