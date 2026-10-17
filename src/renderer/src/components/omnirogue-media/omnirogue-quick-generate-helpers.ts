import { useCallback, useEffect, useRef, useState } from 'react'
import type { OmniRogueCreditsApi } from '../../../../preload/api/omnirogue-api'
import type { OmniRogueCreditBalance } from '../../../../shared/omnirogue-account'
import { quotePosixShell } from '../../../../shared/wsl-login-shell-command'

export const QUICK_GENERATE_ASPECT_RATIOS = ['1:1', '4:5', '16:9', '9:16'] as const
export type QuickGenerateAspectRatio = (typeof QUICK_GENERATE_ASPECT_RATIOS)[number]
export type QuickGenerateAspectSelection = QuickGenerateAspectRatio | 'multi-pack'
export type QuickGenerateKind = 'image' | 'video'
export type QuickGenerateInsertFormat = 'path' | 'markdown'
export type QuickGenerateTerminal = {
  sessionId: string
  hostId: string
  shell: 'posix' | 'powershell' | 'cmd'
}
export type QuickGenerateRequest = {
  prompt: string
  kind: QuickGenerateKind
  aspectRatios: readonly QuickGenerateAspectRatio[]
  terminal: QuickGenerateTerminal
}
export type QuickGenerateQuote = {
  id: string
  // Maximum total charge for the entire batch; the adapter enforces this quote atomically.
  credits: number
  expiresAt: number
}
export type QuickGenerateAsset = {
  path: string
  kind: QuickGenerateKind
  aspectRatio: QuickGenerateAspectRatio
}
// The adapter owns authenticated OmniRogue calls and saving paths on the terminal's host.
export type OmniRogueQuickGenerateService = {
  quote: (request: QuickGenerateRequest, options: { signal: AbortSignal }) => Promise<QuickGenerateQuote>
  generate: (
    request: QuickGenerateRequest,
    options: { quoteId: string; signal: AbortSignal }
  ) => Promise<readonly QuickGenerateAsset[]>
}
export type QuickGenerateInsertion = {
  terminal: QuickGenerateTerminal
  text: string
  format: QuickGenerateInsertFormat
  appendEnter: false
}

export function expandQuickGenerateRatios(selection: QuickGenerateAspectSelection): QuickGenerateAspectRatio[] {
  return selection === 'multi-pack' ? [...QUICK_GENERATE_ASPECT_RATIOS] : [selection]
}

export function isUsableQuickGenerateQuote(quote: QuickGenerateQuote, now = Date.now()): boolean {
  return Boolean(quote.id?.trim()) && Number.isFinite(quote.credits) && quote.credits >= 0 &&
    Number.isFinite(quote.expiresAt) && quote.expiresAt > now
}

export function quickGenerateCreditGuard(balance: OmniRogueCreditBalance | null, cost: number | null) {
  if (cost === null || !Number.isFinite(cost) || cost < 0 || !balance ||
      !Number.isFinite(balance.availableCredits) || balance.availableCredits < 0) {
    return { allowed: false, status: 'unknown' as const }
  }
  if (cost > balance.availableCredits) {
    return { allowed: false, status: 'insufficient' as const }
  }
  const threshold = balance.lowBalanceThreshold ?? 100
  return {
    allowed: true,
    status: balance.availableCredits - cost <= threshold ? 'low' as const : 'ready' as const
  }
}

export function sameQuickGenerateTerminal(a: QuickGenerateTerminal, b: QuickGenerateTerminal | null): boolean {
  return a.sessionId === b?.sessionId && a.hostId === b.hostId && a.shell === b.shell
}

function validateAssetPath(path: string): void {
  // Control bytes can submit commands or alter terminal input even inside shell quotes.
  const hasControls = Array.from(path).some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029
  })
  if (!path.trim() || hasControls) {
    throw new Error('The generated asset has an invalid path.')
  }
}

export function validateQuickGenerateAssets(assets: readonly QuickGenerateAsset[], request: QuickGenerateRequest): void {
  if (assets.length !== request.aspectRatios.length || request.aspectRatios.some(
    (ratio) => assets.filter((asset) => asset.aspectRatio === ratio && asset.kind === request.kind).length !== 1
  )) {
    throw new Error('OmniRogue returned an incomplete batch. Check your media library before generating again.')
  }
  assets.forEach((asset) => validateAssetPath(asset.path))
}

export function formatQuickGenerateAssets(
  assets: readonly QuickGenerateAsset[], format: QuickGenerateInsertFormat, shell: QuickGenerateTerminal['shell']
): string {
  if (!assets.length) {
    throw new Error('No generated assets to insert.')
  }
  return assets.map((asset) => {
    validateAssetPath(asset.path)
    if (format === 'markdown') {
      const normalizedPath = shell === 'posix' ? asset.path : asset.path.replace(/\\/g, '/')
      const destination = normalizedPath.replace(/[ %<>"'`()[\]#?\\]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
      if (/^[a-z][a-z\d+.-]*:/i.test(destination) && !/^[a-z]:\//i.test(destination)) {
        throw new Error('Markdown insertion requires a saved asset path.')
      }
      return asset.kind === 'image'
        ? `![Generated image](<${destination}>)`
        : `<video controls src="${destination.replace(/&/g, '&amp;')}"></video>`
    }
    if (shell === 'powershell') {
      return `'${asset.path.replace(/['\u2018-\u201B]/g, (ch) => ch + ch)}'`
    }
    if (shell === 'cmd') {
      if (/["%!]/.test(asset.path)) {
        throw new Error('This path cannot be safely inserted into cmd.exe. Use Markdown or another shell.')
      }
      return `"${asset.path}"`
    }
    return quotePosixShell(asset.path)
  }).join(' ')
}

export function isQuickGenerateShortcut(event: KeyboardEvent, isMac: boolean): boolean {
  return !event.defaultPrevented && !event.repeat && !event.isComposing && !event.altKey &&
    event.shiftKey && (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    event.key.toLowerCase() === 'g'
}

export function useQuickGenerateBalance(api: OmniRogueCreditsApi | undefined) {
  const [balance, setBalance] = useState<OmniRogueCreditBalance | null>(null)
  const state = useRef({ api, active: false, revision: 0, balance: null as OmniRogueCreditBalance | null })
  const refresh = useCallback(async () => {
    const current = state.current
    if (current.api !== api || !current.active) { return null }
    const revision = ++current.revision
    try {
      const next = await api?.refreshBalance() ?? null
      if (!current.active) { return null }
      if (revision !== current.revision) { return current.balance }
      current.balance = next
      setBalance(next)
      return next
    } catch (error) {
      if (current.active && revision === current.revision) {
        current.balance = null
        setBalance(null)
      }
      throw error
    }
  }, [api])
  useEffect(() => {
    const current = { api, active: true, revision: 0, balance: null as OmniRogueCreditBalance | null }
    state.current = current
    setBalance(null)
    const unsubscribe = api?.onBalanceChanged((next) => {
      if (!current.active) { return }
      current.revision += 1
      current.balance = next
      setBalance(next)
    })
    void refresh().catch(() => {})
    return () => { current.active = false; unsubscribe?.() }
  }, [api, refresh])
  return { balance, refresh }
}
