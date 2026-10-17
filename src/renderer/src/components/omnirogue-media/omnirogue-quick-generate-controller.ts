import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { OmniRogueCreditsApi } from '../../../../preload/api/omnirogue-api'
import {
  expandQuickGenerateRatios,
  formatQuickGenerateAssets,
  isUsableQuickGenerateQuote,
  quickGenerateCreditGuard,
  sameQuickGenerateTerminal,
  useQuickGenerateBalance,
  validateQuickGenerateAssets
} from './omnirogue-quick-generate-helpers'
import type {
  OmniRogueQuickGenerateService,
  QuickGenerateAspectSelection,
  QuickGenerateAsset,
  QuickGenerateInsertion,
  QuickGenerateInsertFormat,
  QuickGenerateKind,
  QuickGenerateQuote,
  QuickGenerateRequest,
  QuickGenerateTerminal
} from './omnirogue-quick-generate-helpers'

const t = (key: string, fallback: string): string =>
  translate(`omnirogueQuickGenerate.${key}`, fallback)

export type QuickGenerateControllerOptions = {
  service: OmniRogueQuickGenerateService
  activeTerminal: QuickGenerateTerminal | null
  onInsert: (insertion: QuickGenerateInsertion) => void | Promise<void>
  creditsApi?: OmniRogueCreditsApi
  onBusyChange: (busy: boolean) => void
}

export function useQuickGenerateController({
  service,
  activeTerminal,
  onInsert,
  creditsApi,
  onBusyChange
}: QuickGenerateControllerOptions) {
  const id = useId()
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<QuickGenerateKind>('image')
  const [ratio, setRatio] = useState<QuickGenerateAspectSelection>('1:1')
  const [format, setFormat] = useState<QuickGenerateInsertFormat>('path')
  const [quote, setQuote] = useState<{
    request: QuickGenerateRequest
    service: OmniRogueQuickGenerateService
    value: QuickGenerateQuote
  } | null>(null)
  const [revision, setRevision] = useState(0)
  const [quoteError, setQuoteError] = useState('')
  const [error, setError] = useState('')
  const [phase, setPhase] = useState<'idle' | 'checking' | 'generating' | 'inserting'>('idle')
  const [result, setResult] = useState<{
    assets: readonly QuickGenerateAsset[]
    terminal: QuickGenerateTerminal
  } | null>(null)
  const operation = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const liveTerminal = useRef(activeTerminal)
  const liveService = useRef(service)
  useEffect(() => {
    liveTerminal.current = activeTerminal
    liveService.current = service
  }, [activeTerminal, service])
  const { balance, refresh } = useQuickGenerateBalance(creditsApi ?? window.api?.omnirogue?.credits)
  const sessionId = activeTerminal?.sessionId,
    hostId = activeTerminal?.hostId,
    shell = activeTerminal?.shell
  const request = useMemo<QuickGenerateRequest | null>(
    () =>
      prompt.trim() && sessionId && hostId && shell
        ? {
            prompt: prompt.trim(),
            kind,
            aspectRatios: expandQuickGenerateRatios(ratio),
            terminal: { sessionId, hostId, shell }
          }
        : null,
    [prompt, kind, ratio, sessionId, hostId, shell]
  )
  const busy = phase !== 'idle'
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      operation.current?.abort()
    }
  }, [])
  useEffect(() => {
    onBusyChange(busy)
    return () => onBusyChange(false)
  }, [busy, onBusyChange])
  useEffect(() => {
    const controller = new AbortController()
    setQuote(null)
    setQuoteError('')
    if (request) {
      void Promise.resolve()
        .then(() => service.quote(request, { signal: controller.signal }))
        .then((value) => {
          if (controller.signal.aborted) {
            return
          }
          if (!isUsableQuickGenerateQuote(value)) {
            throw new Error(t('invalidQuote', 'Credit quote is unavailable. Try again.'))
          }
          setQuote({ request, service, value })
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setQuoteError(t('quoteFailed', 'Could not load the credit cost. Try again.'))
          }
        })
    }
    return () => controller.abort()
  }, [request, service, revision])
  const currentQuote = quote?.request === request && quote.service === service ? quote.value : null
  useEffect(() => {
    if (!currentQuote) {
      return
    }
    const delay = Math.max(0, Math.min(currentQuote.expiresAt - Date.now(), 2_147_483_647))
    const expiry = setTimeout(() => setRevision((value) => value + 1), delay)
    return () => clearTimeout(expiry)
  }, [currentQuote])
  const guard = quickGenerateCreditGuard(balance, currentQuote?.credits ?? null)
  const canGenerate = Boolean(request && currentQuote && guard.allowed && !busy && !result)

  async function generate(): Promise<void> {
    if (!canGenerate || !request || !currentQuote || operation.current) {
      return
    }
    const controller = new AbortController()
    operation.current = controller
    setError('')
    setPhase('checking')
    try {
      const freshBalance = await refresh()
      if (controller.signal.aborted) {
        return
      }
      if (
        !sameQuickGenerateTerminal(request.terminal, liveTerminal.current) ||
        service !== liveService.current
      ) {
        throw new Error(
          t('targetChanged', 'The active terminal changed. Review your request and try again.')
        )
      }
      if (!isUsableQuickGenerateQuote(currentQuote)) {
        setRevision((value) => value + 1)
        throw new Error(
          t('expired', 'The credit quote expired. Review the updated cost and try again.')
        )
      }
      if (!quickGenerateCreditGuard(freshBalance, currentQuote.credits).allowed) {
        throw new Error(
          t(
            'balanceChanged',
            'Your credit balance is unavailable or insufficient. Refresh credits and try again.'
          )
        )
      }
      setPhase('generating')
      const assets = await service.generate(request, {
        quoteId: currentQuote.id,
        signal: controller.signal
      })
      if (controller.signal.aborted) {
        return
      }
      validateQuickGenerateAssets(assets, request)
      setResult({ assets, terminal: request.terminal })
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        setError(
          cause instanceof Error
            ? cause.message
            : t('generateFailed', 'Generation failed. Check your media library before retrying.')
        )
      }
    } finally {
      if (mounted.current && !controller.signal.aborted) {
        operation.current = null
        setPhase('idle')
        void refresh().catch(() => {})
      }
    }
  }
  async function insert(): Promise<void> {
    if (
      !result ||
      operation.current ||
      !sameQuickGenerateTerminal(result.terminal, activeTerminal)
    ) {
      return
    }
    const controller = new AbortController()
    operation.current = controller
    setPhase('inserting')
    setError('')
    try {
      await onInsert({
        terminal: result.terminal,
        format,
        appendEnter: false,
        text: formatQuickGenerateAssets(result.assets, format, result.terminal.shell)
      })
      if (!controller.signal.aborted) {
        setResult(null)
        setPrompt('')
        setQuote(null)
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(
          cause instanceof Error
            ? cause.message
            : t('insertFailed', 'Could not insert assets. Try again.')
        )
      }
    } finally {
      if (mounted.current && !controller.signal.aborted) {
        operation.current = null
        setPhase('idle')
      }
    }
  }
  return {
    id,
    prompt,
    setPrompt,
    kind,
    setKind,
    ratio,
    setRatio,
    format,
    setFormat,
    setRevision,
    quoteError,
    error,
    setError,
    phase,
    result,
    balance,
    refresh,
    request,
    busy,
    currentQuote,
    guard,
    canGenerate,
    generate,
    insert
  }
}
