import { Plug } from 'lucide-react'
import { ClaudeIcon, GeminiIcon, OpenAIIcon } from '@/components/status-bar/icons'
import type { SessionProviderId } from '../../../shared/session-capabilities'
import { MetaIcon } from './agent-icon-glyphs'

// Why: every mark is bundled inline so logos render offline and under the CSP; nothing fetches a favicon.

export type ProviderIconId =
  | SessionProviderId
  | 'gemini'
  | 'veo'
  | 'meta'
  | 'github'
  | 'linear'
  | 'slack'
  | 'mcp'

type GlyphProps = { size: number }

function Svg({
  size,
  viewBox = '0 0 24 24',
  children
}: GlyphProps & { viewBox?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      fill="currentColor"
    >
      {children}
    </svg>
  )
}

function OpenRouterGlyph({ size }: GlyphProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3 12h4.5c2 0 3-.8 4.4-2.4L14 7.2c1.3-1.5 2.3-2.2 4.2-2.2H21v2h-2.8c-1.2 0-1.8.4-2.8 1.6L13.3 11c-.4.4-.7.7-1 1 .3.3.6.6 1 1l2.1 2.4c1 1.2 1.6 1.6 2.8 1.6H21v2h-2.8c-1.9 0-2.9-.7-4.2-2.2l-2.1-2.4C10.5 13.8 9.5 13 7.5 13H3z" />
      <path d="M19 2.5 23 6l-4 3.5zM19 14.5l4 3.5-4 3.5z" />
    </Svg>
  )
}

function GoogleGlyph({ size }: GlyphProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" />
      <path d="M12 22c2.7 0 5-.9 6.6-2.5l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" />
      <path d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9z" />
      <path d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.7 9.7 0 0 0 12 2a10 10 0 0 0-8.9 5.5l3.3 2.6C7.2 7.8 9.4 6 12 6z" />
    </Svg>
  )
}

function VeoGlyph({ size }: GlyphProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h9A2.5 2.5 0 0 1 17 6.5v1.8l4-2.3v12l-4-2.3v1.8a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 17.5zm5 1.8v7.4l6-3.7z" />
    </Svg>
  )
}

function XaiGlyph({ size }: GlyphProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3 3h3.6l5.4 7.6L17.4 3H21l-7.2 10L21 21h-3.6L12 13.4 6.6 21H3l7.2-8z" />
    </Svg>
  )
}

function FalGlyph({ size }: GlyphProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 4.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z" />
    </Svg>
  )
}

function ElevenLabsGlyph({ size }: GlyphProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <rect x="7" y="3" width="3.5" height="18" rx="0.5" />
      <rect x="13.5" y="3" width="3.5" height="18" rx="0.5" />
    </Svg>
  )
}

function ReplicateGlyph({ size }: GlyphProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M21 3v2.3H8.2V21H5.7V3z" />
      <path d="M21 7.3v2.3h-8.3V21h-2.5V7.3z" />
      <path d="M21 11.6v2.3h-3.8V21h-2.5v-9.4z" />
    </Svg>
  )
}

function GitHubGlyph({ size }: GlyphProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 2.9.8.1-.7.4-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z" />
    </Svg>
  )
}

function LinearGlyph({ size }: GlyphProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M2.3 14.1 9.9 21.7A10 10 0 0 1 2.3 14.1zM2 11.4l10.6 10.6c.8 0 1.6-.2 2.3-.4L2.4 9.1c-.2.7-.4 1.5-.4 2.3zM3.1 7.5l13.4 13.4c.6-.3 1.1-.6 1.6-1L4.1 5.9c-.4.5-.7 1-1 1.6zM5.5 4.4A10 10 0 1 1 19.6 18.5z" />
    </Svg>
  )
}

function SlackGlyph({ size }: GlyphProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M5.1 15.1a2.1 2.1 0 1 1-2.1-2.1h2.1zm1 0a2.1 2.1 0 0 1 4.2 0v5.3a2.1 2.1 0 1 1-4.2 0z" />
      <path d="M8.9 5.1A2.1 2.1 0 1 1 11 3v2.1zm0 1a2.1 2.1 0 0 1 0 4.2H3.6a2.1 2.1 0 1 1 0-4.2z" />
      <path d="M18.9 8.9A2.1 2.1 0 1 1 21 11h-2.1zm-1 0a2.1 2.1 0 0 1-4.2 0V3.6a2.1 2.1 0 1 1 4.2 0z" />
      <path d="M15.1 18.9A2.1 2.1 0 1 1 13 21v-2.1zm0-1a2.1 2.1 0 0 1 0-4.2h5.3a2.1 2.1 0 1 1 0 4.2z" />
    </Svg>
  )
}

export const PROVIDER_ICON_LABELS: Record<ProviderIconId, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  xai: 'xAI',
  google: 'Google',
  gemini: 'Gemini',
  veo: 'Veo',
  meta: 'Meta',
  fal: 'fal',
  elevenlabs: 'ElevenLabs',
  replicate: 'Replicate',
  github: 'GitHub',
  linear: 'Linear',
  slack: 'Slack',
  mcp: 'MCP'
}

export function ProviderIcon({
  id,
  size = 14
}: {
  id: ProviderIconId
  size?: number
}): React.JSX.Element {
  switch (id) {
    case 'openai':
      return <OpenAIIcon size={size} />
    case 'anthropic':
      return <ClaudeIcon size={size} />
    case 'gemini':
      return <GeminiIcon size={size} />
    case 'openrouter':
      return <OpenRouterGlyph size={size} />
    case 'google':
      return <GoogleGlyph size={size} />
    case 'veo':
      return <VeoGlyph size={size} />
    case 'meta':
      return <MetaIcon size={size} />
    case 'xai':
      return <XaiGlyph size={size} />
    case 'fal':
      return <FalGlyph size={size} />
    case 'elevenlabs':
      return <ElevenLabsGlyph size={size} />
    case 'replicate':
      return <ReplicateGlyph size={size} />
    case 'github':
      return <GitHubGlyph size={size} />
    case 'linear':
      return <LinearGlyph size={size} />
    case 'slack':
      return <SlackGlyph size={size} />
    case 'mcp':
      return <Plug width={size} height={size} aria-hidden />
  }
}

const MCP_NAME_ICONS: readonly [RegExp, ProviderIconId][] = [
  [/github/i, 'github'],
  [/linear/i, 'linear'],
  [/slack/i, 'slack'],
  [/openrouter/i, 'openrouter'],
  [/eleven\s*labs|elevenlabs/i, 'elevenlabs'],
  [/replicate/i, 'replicate'],
  [/\bfal\b|fal[-_.]?ai/i, 'fal'],
  [/\bveo\b/i, 'veo'],
  [/gemini/i, 'gemini'],
  [/google|vertex/i, 'google'],
  [/openai/i, 'openai'],
  [/anthropic|claude/i, 'anthropic'],
  [/\bxai\b|grok/i, 'xai']
]

/** Best-effort brand for an MCP server name; unrecognized servers get the generic plug. */
export function providerIconIdForMcpServer(name: string): ProviderIconId {
  return MCP_NAME_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? 'mcp'
}

/** Brand for an agent/workflow provider or model string (e.g. `openrouter`, `gpt-5`, `gemini-2.5`). */
export function providerIconIdForModel(value: string | null | undefined): ProviderIconId | null {
  if (!value) {
    return null
  }
  if (/openrouter/i.test(value)) {
    return 'openrouter'
  }
  if (/^(gpt|o\d|codex)|openai/i.test(value)) {
    return 'openai'
  }
  if (/claude|anthropic|opus|sonnet|haiku/i.test(value)) {
    return 'anthropic'
  }
  if (/veo/i.test(value)) {
    return 'veo'
  }
  if (/gemini/i.test(value)) {
    return 'gemini'
  }
  if (/grok|xai/i.test(value)) {
    return 'xai'
  }
  // Why: Muse Code (agent `muse`, models `muse-spark-…`/`muse-wonder-…`) is Meta's agent.
  if (/\bmuse\b|\bmeta\b/i.test(value)) {
    return 'meta'
  }
  return null
}
