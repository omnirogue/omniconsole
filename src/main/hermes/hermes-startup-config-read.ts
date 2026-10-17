import { readFile } from 'node:fs/promises'
import type { ConfigParseResult } from './hermes-config-yaml'
import { parseHermesConfig } from './hermes-config-yaml'

/** A removable-drive access prompt must not block Electron's main thread. */
export async function readHermesConfigForInstall(
  configPath: string,
  timeoutMs = 1_500
): Promise<ConfigParseResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = readFile(configPath, { encoding: 'utf-8', signal: controller.signal })
    .then(parseHermesConfig)
    .catch((error: unknown): ConfigParseResult => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { ok: true, config: {} }
      }
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    })
  try {
    return await Promise.race([
      read,
      new Promise<ConfigParseResult>((resolve) => {
        timer = setTimeout(() => {
          resolve({ ok: false, detail: 'Timed out opening Hermes config; check drive access.' })
          controller.abort()
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
