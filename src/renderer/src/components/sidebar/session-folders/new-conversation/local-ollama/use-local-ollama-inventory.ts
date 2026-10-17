import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  OLLAMA_DEFAULT_BASE_URL,
  type OllamaInventory
} from '../../../../../../../shared/local-ollama-launch'
import type { LocalOllamaPullProgress } from '../../../../../../../preload/api/local-ollama-api'

export type LocalOllamaInventoryState = {
  /** `null` until the first probe answers. */
  inventory: OllamaInventory | null
  checking: boolean
  refresh: () => Promise<OllamaInventory | null>
  pulls: Record<string, LocalOllamaPullProgress>
  pull: (model: string) => Promise<boolean>
}

function localOllamaApi(): NonNullable<typeof window.api.localOllama> | null {
  return window.api?.localOllama ?? null
}

/**
 * Installed Ollama models, refreshed on demand, plus in-flight pulls with their progress.
 * A refresh that throws reports `disconnected`; an older refresh never overwrites a newer
 * one; a rejected pull always clears its busy state.
 */
export function useLocalOllamaInventory(enabled: boolean): LocalOllamaInventoryState {
  const [inventory, setInventory] = useState<OllamaInventory | null>(null)
  const [checking, setChecking] = useState(false)
  const [pulls, setPulls] = useState<Record<string, LocalOllamaPullProgress>>({})
  const mounted = useRef(true)
  const generation = useRef(0)
  const lastKnownBaseUrl = useRef(OLLAMA_DEFAULT_BASE_URL)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<OllamaInventory | null> => {
    const api = localOllamaApi()
    if (!api) {
      const absent: OllamaInventory = {
        status: 'disconnected',
        baseUrl: OLLAMA_DEFAULT_BASE_URL,
        message: translate(
          'localOllama.desktopOnly',
          'Local Ollama sessions can only start from the OmniConsole desktop app.'
        )
      }
      setInventory(absent)
      return absent
    }
    const mine = ++generation.current
    setChecking(true)
    let next: OllamaInventory
    try {
      next = await api.listModels()
    } catch (error) {
      next = {
        status: 'disconnected',
        baseUrl: lastKnownBaseUrl.current,
        message: error instanceof Error ? error.message : String(error)
      }
    }
    lastKnownBaseUrl.current = next.baseUrl
    // Why: a slow, stale answer must not replace the one fetched after a pull.
    if (mounted.current && mine === generation.current) {
      setInventory(next)
      setChecking(false)
    }
    return next
  }, [])

  useEffect(() => {
    if (enabled) {
      void refresh()
    }
  }, [enabled, refresh])

  useEffect(() => {
    const api = localOllamaApi()
    if (!enabled || !api) {
      return
    }
    // Why: progress for a pull started elsewhere (Settings) still belongs in this view.
    return api.onPullProgress((progress) => {
      if (progress.status === 'success' || progress.status === 'error') {
        setPulls((current) => {
          const { [progress.model]: _done, ...rest } = current
          return rest
        })
        void refresh()
        return
      }
      setPulls((current) => ({ ...current, [progress.model]: progress }))
    })
  }, [enabled, refresh])

  const pull = useCallback(
    async (model: string): Promise<boolean> => {
      const api = localOllamaApi()
      if (!api) {
        return false
      }
      setPulls((current) => ({ ...current, [model]: { model, status: 'starting' } }))
      let result: { ok: true } | { ok: false; message: string }
      try {
        result = await api.pullModel({ model })
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) }
      } finally {
        if (mounted.current) {
          setPulls((current) => {
            const { [model]: _done, ...rest } = current
            return rest
          })
        }
      }
      if (!result.ok) {
        toast.error(translate('localOllama.pullFailed', 'Could not pull {{model}}.', { model }), {
          description: result.message
        })
      } else {
        toast.success(translate('localOllama.pulled', '{{model}} is installed.', { model }))
      }
      await refresh()
      return result.ok
    },
    [refresh]
  )

  return { inventory, checking, refresh, pulls, pull }
}
