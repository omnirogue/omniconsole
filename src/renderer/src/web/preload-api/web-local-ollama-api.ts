import { translate } from '@/i18n/i18n'
import type { PreloadApi } from '../../../../preload/api-types'
import { OLLAMA_DEFAULT_BASE_URL } from '../../../../shared/local-ollama-launch'

// The browser client cannot reach a model server on the desktop, so it reports
// disconnected rather than an empty inventory.
export function createWebLocalOllamaApi(): Pick<PreloadApi, 'localOllama'> {
  const desktopOnly = () =>
    translate(
      'localOllama.desktopOnly',
      'Local Ollama sessions can only start from the OmniConsole desktop app.'
    )
  return {
    localOllama: {
      listModels: () =>
        Promise.resolve({
          status: 'disconnected' as const,
          baseUrl: OLLAMA_DEFAULT_BASE_URL,
          message: desktopOnly()
        }),
      pullModel: () => Promise.resolve({ ok: false as const, message: desktopOnly() }),
      readGlobalInstructions: () =>
        Promise.resolve({ ok: false as const, path: '', message: desktopOnly() }),
      writeGlobalInstructions: () =>
        Promise.resolve({ ok: false as const, path: '', message: desktopOnly() }),
      onPullProgress: () => () => {},
      prepareLaunch: () => Promise.resolve({ ok: false as const, message: desktopOnly() }),
      // Why: the web client keeps launch memory in its own preferences; the caller falls back.
      rememberLaunchContext: () => Promise.resolve({ ok: false as const, message: desktopOnly() })
    }
  }
}
