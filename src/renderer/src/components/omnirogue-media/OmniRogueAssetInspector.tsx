import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, FolderOpen, ImageIcon, Loader2, SquareTerminal, Video, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  assetFileName, assetInspectorFields, assetInspectorKey, assetInspectorPrompt,
  resolveAssetInspectorLabels, safeAssetPreviewUrl
} from './omnirogue-asset-inspector-helpers'
import type {
  AssetInspectorAction, OmniRogueAssetInspectorLabels, OmniRogueInspectedAsset
} from './omnirogue-asset-inspector-helpers'

export type OmniRogueAssetInspectorProps = {
  asset: OmniRogueInspectedAsset | null
  labels?: Partial<OmniRogueAssetInspectorLabels>
  locale?: string
  // Defaults to the system clipboard; override to route through the host's clipboard bridge.
  onCopy?: (text: string) => void | Promise<void>
  onReveal?: (asset: OmniRogueInspectedAsset) => void | Promise<void>
  // The caller owns terminal targeting and formatting (see formatQuickGenerateAssets).
  onInsert?: (asset: OmniRogueInspectedAsset) => void | Promise<void>
  onClose?: () => void
  className?: string
}

export function OmniRogueAssetInspector({
  asset, labels: labelOverrides, locale, onCopy, onReveal, onInsert, onClose, className
}: OmniRogueAssetInspectorProps): React.ReactElement {
  const labels = useMemo(() => resolveAssetInspectorLabels(labelOverrides), [labelOverrides])
  return (
    <section aria-label={labels.title} className={cn('flex min-w-0 flex-col gap-3 rounded-md border bg-card p-3 text-xs', className)}>
      {asset ? (
        <InspectorBody
          key={assetInspectorKey(asset)} asset={asset} labels={labels} locale={locale}
          onCopy={onCopy} onReveal={onReveal} onInsert={onInsert} onClose={onClose}
        />
      ) : (
        <>
          <InspectorHeader labels={labels} onClose={onClose} />
          <p className="text-muted-foreground">{labels.empty}</p>
        </>
      )}
    </section>
  )
}

function InspectorHeader({ labels, onClose, children }: {
  labels: OmniRogueAssetInspectorLabels
  onClose?: () => void
  children?: React.ReactNode
}): React.ReactElement {
  return (
    <header className="flex items-start gap-2">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{labels.title}</p>
        {children}
      </div>
      {onClose ? (
        <Button type="button" variant="ghost" size="icon-xs" aria-label={labels.close} onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      ) : null}
    </header>
  )
}

type BodyProps = Omit<OmniRogueAssetInspectorProps, 'asset' | 'labels' | 'className'> & {
  asset: OmniRogueInspectedAsset
  labels: OmniRogueAssetInspectorLabels
}

type InspectorStatus = { tone: 'success' | 'error'; message: string }

function InspectorBody({ asset, labels, locale, onCopy, onReveal, onInsert, onClose }: BodyProps): React.ReactElement {
  const [pending, setPending] = useState<AssetInspectorAction | null>(null)
  const [status, setStatus] = useState<InspectorStatus | null>(null)
  const active = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  const fields = useMemo(() => assetInspectorFields(asset, labels, locale), [asset, labels, locale])
  const prompt = assetInspectorPrompt(asset)
  const fileName = assetFileName(asset.path)
  const KindIcon = asset.kind === 'video' ? Video : ImageIcon

  async function run(
    action: AssetInspectorAction, task: () => void | Promise<void>, success: string | null, failure: string
  ): Promise<void> {
    if (inFlight.current) {
      return
    }
    inFlight.current = true
    setPending(action)
    setStatus(null)
    try {
      await task()
      if (active.current && success) {
        setStatus({ tone: 'success', message: success })
      }
    } catch {
      if (active.current) {
        setStatus({ tone: 'error', message: failure })
      }
    } finally {
      inFlight.current = false
      if (active.current) {
        setPending(null)
      }
    }
  }
  function copy(action: 'copyPath' | 'copyPrompt', text: string): void {
    const write = onCopy ?? ((value: string) => navigator.clipboard.writeText(value))
    void run(action, () => write(text), labels.copied, labels.copyFailed)
  }
  const icon = (action: AssetInspectorAction, Fallback: typeof Copy): React.ReactElement =>
    pending === action ? <Loader2 className="size-3.5 motion-safe:animate-spin" /> : <Fallback className="size-3.5" />

  return (
    <>
      <InspectorHeader labels={labels} onClose={onClose}>
        <div className="flex min-w-0 items-center gap-2">
          <KindIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <h3 className="min-w-0 truncate text-sm font-medium" title={asset.path}>{fileName}</h3>
          <Badge variant="secondary">{labels[asset.kind]}</Badge>
        </div>
      </InspectorHeader>
      <AssetPreview
        key={asset.previewUrl ?? ''} asset={asset} labels={labels}
        url={safeAssetPreviewUrl(asset.previewUrl, asset.kind)}
      />
      <div className="space-y-1.5">
        <p className="font-medium">{labels.details}</p>
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
          {fields.map((field) => (
            <React.Fragment key={field.key}>
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="min-w-0 break-words">{field.value}</dd>
            </React.Fragment>
          ))}
          <dt className="text-muted-foreground">{labels.path}</dt>
          <dd className="min-w-0 break-all font-mono">{asset.path}</dd>
        </dl>
      </div>
      {prompt ? (
        <div className="space-y-1.5">
          <p className="font-medium">{labels.prompt}</p>
          <p className="scrollbar-sleek max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2">
            {prompt}
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={pending !== null} onClick={() => copy('copyPath', asset.path)}>
          {icon('copyPath', Copy)}{labels.copyPath}
        </Button>
        {prompt ? (
          <Button type="button" variant="outline" size="sm" disabled={pending !== null} onClick={() => copy('copyPrompt', prompt)}>
            {icon('copyPrompt', Copy)}{labels.copyPrompt}
          </Button>
        ) : null}
        {onReveal ? (
          <Button
            type="button" variant="outline" size="sm" disabled={pending !== null}
            onClick={() => void run('reveal', () => onReveal(asset), null, labels.revealFailed)}
          >
            {icon('reveal', FolderOpen)}{labels.reveal}
          </Button>
        ) : null}
        {onInsert ? (
          <Button
            type="button" size="sm" disabled={pending !== null}
            onClick={() => void run('insert', () => onInsert(asset), labels.inserted, labels.insertFailed)}
          >
            {icon('insert', SquareTerminal)}{labels.insert}
          </Button>
        ) : null}
      </div>
      <p
        role="status" aria-live="polite"
        className={cn('min-h-4', status?.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}
      >
        {status?.message}
      </p>
    </>
  )
}

function AssetPreview({ asset, labels, url }: {
  asset: OmniRogueInspectedAsset
  labels: OmniRogueAssetInspectorLabels
  url: string | null
}): React.ReactElement {
  const [failed, setFailed] = useState(false)
  if (!url || failed) {
    return (
      <div className="flex min-h-24 items-center justify-center rounded-md border border-dashed bg-muted/40 p-3 text-center text-muted-foreground">
        {labels.previewUnavailable}
      </div>
    )
  }
  if (asset.kind === 'video') {
    return (
      <video
        src={url} controls muted playsInline preload="metadata" aria-label={labels.previewAlt}
        className="max-h-64 w-full rounded-md bg-black/80" onError={() => setFailed(true)}
      />
    )
  }
  return (
    <img
      src={url} alt={labels.previewAlt} loading="lazy" decoding="async" draggable={false}
      className="max-h-64 w-full rounded-md bg-muted/40 object-contain" onError={() => setFailed(true)}
    />
  )
}
