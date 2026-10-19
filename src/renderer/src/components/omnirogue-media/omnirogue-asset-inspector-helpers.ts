import type { QuickGenerateAspectRatio, QuickGenerateKind } from './omnirogue-quick-generate-helpers'

export type OmniRogueInspectedAsset = {
  id: string
  // Saved path on the host that owns the asset; never fetched by the inspector itself.
  path: string
  kind: QuickGenerateKind
  aspectRatio?: QuickGenerateAspectRatio
  // Renderer-loadable URL supplied by the adapter; filtered through safeAssetPreviewUrl.
  previewUrl?: string
  width?: number
  height?: number
  durationSeconds?: number
  sizeBytes?: number
  model?: string
  prompt?: string
  credits?: number
  createdAt?: string | number
}

export const OMNIROGUE_ASSET_INSPECTOR_LABELS = {
  title: 'Asset inspector',
  empty: 'Select a generated asset to inspect it.',
  image: 'Image',
  video: 'Video',
  previewAlt: 'Preview of the selected asset',
  previewUnavailable: 'Preview unavailable. The details below are still accurate.',
  details: 'Details',
  kind: 'Media type',
  aspectRatio: 'Aspect ratio',
  dimensions: 'Dimensions',
  duration: 'Duration',
  size: 'File size',
  model: 'Model',
  credits: 'Credits used',
  createdAt: 'Created',
  path: 'Saved path',
  prompt: 'Prompt',
  creditsUnit: 'cr',
  copyPath: 'Copy path',
  copyPrompt: 'Copy prompt',
  reveal: 'Show in folder',
  insert: 'Insert into terminal',
  close: 'Close inspector',
  copied: 'Copied to clipboard.',
  inserted: 'Inserted into terminal.',
  copyFailed: 'Could not copy. Try again.',
  revealFailed: 'Could not open the folder. Try again.',
  insertFailed: 'Could not insert the asset. Try again.'
} as const

export type OmniRogueAssetInspectorLabels = Record<keyof typeof OMNIROGUE_ASSET_INSPECTOR_LABELS, string>
export type AssetInspectorAction = 'copyPath' | 'copyPrompt' | 'reveal' | 'insert'
export type AssetInspectorField = {
  key: 'kind' | 'aspectRatio' | 'dimensions' | 'duration' | 'size' | 'model' | 'credits' | 'createdAt'
  label: string
  value: string
}

export function resolveAssetInspectorLabels(
  overrides?: Partial<OmniRogueAssetInspectorLabels>
): OmniRogueAssetInspectorLabels {
  const labels: OmniRogueAssetInspectorLabels = { ...OMNIROGUE_ASSET_INSPECTOR_LABELS }
  if (!overrides) {
    return labels
  }
  for (const key of Object.keys(labels) as (keyof OmniRogueAssetInspectorLabels)[]) {
    const value = overrides[key]
    // Blank overrides would leave controls without an accessible name.
    if (typeof value === 'string' && value.trim()) {
      labels[key] = value
    }
  }
  return labels
}

function finiteAtLeast(value: number | undefined, minimum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim()
  return text ? text : null
}

export function assetInspectorKey(asset: OmniRogueInspectedAsset): string {
  return `${asset.id}\u0000${asset.path}`
}

export function assetFileName(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean)
  return segments.at(-1) ?? path
}

export function formatAssetBytes(bytes: number | undefined, locale = 'en-US'): string | null {
  if (!finiteAtLeast(bytes, 0)) {
    return null
  }
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const
  let value = bytes
  let index = 0
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000
    index += 1
  }
  // Short "byte" reads as a typo in English ("512 byte"), so bytes use the long form.
  return new Intl.NumberFormat(locale, {
    style: 'unit', unit: units[index], unitDisplay: index === 0 ? 'long' : 'short', maximumFractionDigits: index === 0 ? 0 : 1
  }).format(value)
}

export function formatAssetDuration(seconds: number | undefined): string | null {
  if (!finiteAtLeast(seconds, 0)) {
    return null
  }
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = String(total % 60).padStart(2, '0')
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
  }
  return `${minutes}:${rest}`
}

export function formatAssetDimensions(
  width: number | undefined, height: number | undefined, locale = 'en-US'
): string | null {
  if (!finiteAtLeast(width, 1) || !finiteAtLeast(height, 1)) {
    return null
  }
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
  return `${format.format(width)} × ${format.format(height)}`
}

export function formatAssetCredits(credits: number | undefined, unit: string, locale = 'en-US'): string | null {
  if (!finiteAtLeast(credits, 0)) {
    return null
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(credits)} ${unit}`
}

export function formatAssetCreatedAt(value: string | number | undefined, locale = 'en-US'): string | null {
  if (value === undefined || value === '') {
    return null
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

const SAFE_DATA_PREVIEW: Record<QuickGenerateKind, RegExp> = {
  image: /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i,
  video: /^data:video\/(?:mp4|webm|quicktime);base64,/i
}

// Fails closed: only same-origin blobs, local files, HTTPS and raster/video data URLs render.
export function safeAssetPreviewUrl(url: string | undefined, kind: QuickGenerateKind): string | null {
  const candidate = url?.trim()
  if (!candidate) {
    return null
  }
  if (candidate.toLowerCase().startsWith('data:')) {
    return SAFE_DATA_PREVIEW[kind].test(candidate) ? candidate : null
  }
  try {
    const { protocol } = new URL(candidate)
    return protocol === 'blob:' || protocol === 'file:' || protocol === 'https:' ? candidate : null
  } catch {
    return null
  }
}

export function assetInspectorFields(
  asset: OmniRogueInspectedAsset, labels: OmniRogueAssetInspectorLabels, locale = 'en-US'
): AssetInspectorField[] {
  const candidates: [AssetInspectorField['key'], string | null][] = [
    ['kind', labels[asset.kind]],
    ['aspectRatio', asset.aspectRatio ?? null],
    ['dimensions', formatAssetDimensions(asset.width, asset.height, locale)],
    ['duration', asset.kind === 'video' ? formatAssetDuration(asset.durationSeconds) : null],
    ['size', formatAssetBytes(asset.sizeBytes, locale)],
    ['model', trimmed(asset.model)],
    ['credits', formatAssetCredits(asset.credits, labels.creditsUnit, locale)],
    ['createdAt', formatAssetCreatedAt(asset.createdAt, locale)]
  ]
  const fields: AssetInspectorField[] = []
  for (const [key, value] of candidates) {
    if (value !== null) {
      fields.push({ key, label: labels[key], value })
    }
  }
  return fields
}

export function assetInspectorPrompt(asset: OmniRogueInspectedAsset): string | null {
  return trimmed(asset.prompt)
}
