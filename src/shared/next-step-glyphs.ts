import type { SessionActionPresetId } from './session-action-presets'

/**
 * Sal's icon language (2026-09-11): glyphs say what is happening; they are never controls.
 * One glyph per action, plus the three that describe a chain's shape.
 */
export const NEXT_STEP_ACTION_GLYPH: Record<SessionActionPresetId, string> = {
  improve: '✨',
  review: '👀',
  verify: '✓',
  analyze: '🔎',
  research: '🔬',
  plan: '📝',
  implement: '🛠',
  synthesize: '🧩',
  critique: '🗯',
  compare: '📊',
  judge: '⚖',
  summarize: '📄',
  test: '🧪',
  repair: '🩹'
}

/** The order the actions are offered in: the everyday ones first. Work-plan-only roles are not offered here. */
export const NEXT_STEP_ACTION_ORDER: readonly SessionActionPresetId[] = [
  'improve',
  'review',
  'verify',
  'analyze',
  'research',
  'plan',
  'implement',
  'synthesize'
]

export const NEXT_STEP_SHAPE_GLYPH = {
  handoff: '→',
  parallel: '⑂',
  rounds: '↻',
  agent: '🤖',
  person: '👤',
  files: '📎',
  more: '⋯'
} as const
