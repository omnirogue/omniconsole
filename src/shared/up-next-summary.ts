/**
 * The two lines above an Up next chain: the notation, and the computed summary.
 *
 * Both are pure functions of the blocks, so the host and the renderer cannot disagree
 * about them. The notation is ONE string built from done + now + queued, which is why
 * the running node is `●` and the word "Current" appears nowhere; nested prompts fold
 * into their parent as `💬×n` (v3 amendment 13). The summary is the structured form of
 * amendment 14 — the renderer owns the words, the engine owns the counts.
 */

import { SESSION_ACTION_PRESET_LABELS } from './session-action-presets'
import { upNextNumber } from './up-next-order'
import { upNextSendWaits } from './up-next-person-send'
import {
  upNextIsFinished,
  upNextIsStoppedStage,
  type UpNextAgentBlock,
  type UpNextAgentTemplate,
  type UpNextBlock,
  type UpNextBlockState,
  type UpNextHeader,
  type UpNextNow,
  type UpNextSummary,
  type UpNextSummaryStart
} from './up-next-types'

/** What the composer is looking at: the blocks in order, plus the runtime's own facts. */
export type UpNextSummaryInput = {
  blocks: readonly UpNextBlock[]
  header: UpNextHeader
  now: UpNextNow
  /** Done When receipts at the current revision; only a receipt counts (invariant 4). */
  doneWhen?: { met: number; total: number }
}

const TEMPLATE_GLYPHS: Record<UpNextAgentTemplate, string> = {
  research: '🔎',
  analyze: '🔬',
  plan: '📝',
  implement: '🛠',
  improve: '✨',
  synthesize: '◇',
  verify: '✓',
  review: '👀',
  critique: '⚔',
  compare: '⇄',
  judge: '⚖',
  summarize: '🗒',
  test: '🧪',
  repair: '🔧',
  custom: '⚙'
}

function templateLabel(template: UpNextAgentTemplate): string {
  return template === 'custom' ? 'Custom' : SESSION_ACTION_PRESET_LABELS[template]
}

/** Seats one stage runs: a council and a best-of also run their judge. */
export function upNextStageExecutions(block: UpNextAgentBlock): number {
  if (block.shape === 'solo') {
    return 1
  }
  return block.shape === 'council' || block.shape === 'best-of' ? block.n + 1 : block.n
}

function shapeGlyph(block: UpNextAgentBlock): string {
  switch (block.shape) {
    case 'solo':
      return ''
    case 'parallel':
      return `⑂${block.n} `
    case 'council':
      return `⑂${block.n}→◇ `
    case 'best-of':
      return `⑂${block.n}→⚖ `
    case 'custom':
      return '⚙ '
  }
}

function stateGlyph(block: UpNextBlock): string {
  if (block.state === 'done') {
    return '✓ '
  }
  if (block.state === 'running') {
    return '● '
  }
  if (block.state === 'recovering') {
    return '↻ '
  }
  // ▲ marks the two stops nothing clears by itself; a wait keeps its plain glyph.
  return block.state === 'needs-you' || block.state === 'failed' ? '▲ ' : ''
}

function firstName(name: string): string {
  return name.split(' ')[0] ?? name
}

/** `waits` is the send's own choice, or its default when nobody has ticked it yet. */
function blockNotation(block: UpNextBlock, waits: boolean): string {
  if (block.kind === 'agent') {
    return `${stateGlyph(block)}${shapeGlyph(block)}${TEMPLATE_GLYPHS[block.template]} ${templateLabel(block.template)}`
  }
  if (block.kind === 'done') {
    return '✔ Done ■'
  }
  if (block.kind === 'person') {
    return waits
      ? `👥 review ×${block.people.length} ↩`
      : `👤 ${block.people[0] ? firstName(block.people[0].name) : '…'} ■`
  }
  return '💬'
}

/**
 * `● Improve → ⑂3→◇ 👀 Review 💬×3 → ✓ Verify → 👤 Sal ■`. Empty when there is
 * nothing to say: no current work and no blocks.
 */
export function upNextNotation(input: UpNextSummaryInput): string {
  const { parentIds } = upNextNumber(input.blocks)
  const segments: { text: string; prompts: number }[] = []
  const byId = new Map<string, { text: string; prompts: number }>()
  input.blocks.forEach((block, index) => {
    const parentId = parentIds[index]
    if (block.kind === 'prompt' && parentId) {
      const parent = byId.get(parentId)
      if (parent) {
        parent.prompts += 1
        return
      }
    }
    const segment = { text: blockNotation(block, upNextSendWaits(input.blocks, index)), prompts: 0 }
    byId.set(block.id, segment)
    segments.push(segment)
  })
  if (
    !input.blocks.some((block) => block.state === 'running' || upNextIsStoppedStage(block)) &&
    input.now.kind === 'current-work'
  ) {
    // Something IS running, so the notation has to say so in words. The host leaves `label`
    // empty when it cannot read what the agent is doing and `agent` empty when it cannot even
    // name it (`UpNextNow`), and a bare `●` said neither — it read as a glyph with nothing
    // after it. Named by what is known: the activity, else who is working, else that it is.
    segments.unshift({
      text: `● ${input.now.label || input.now.agent || 'working'}`.trimEnd(),
      prompts: 0
    })
  }
  return segments
    .map((segment) => `${segment.text}${segment.prompts ? ` 💬×${segment.prompts}` : ''}`)
    .join(' → ')
}

const PLANNED: readonly UpNextBlockState[] = ['draft', 'queued', 'waiting']

function startClause(
  input: UpNextSummaryInput,
  runningStage: string | undefined
): {
  start: UpNextSummaryStart
  afterStage?: string
} {
  if (runningStage) {
    return { start: 'after-stage', afterStage: runningStage }
  }
  const head = input.blocks[0]
  if (head?.kind === 'prompt' && head.target.kind === 'current' && head.when === 'now') {
    return { start: 'now-interrupts' }
  }
  return { start: input.header.state === 'idle' ? 'now' : 'after-current-work' }
}

/** The counts behind "3 stages · 7 executions · 2 prompts · … · after current work". */
export function upNextSummary(input: UpNextSummaryInput): UpNextSummary {
  const { numbers, topLevel } = upNextNumber(input.blocks)
  const number = (block: UpNextBlock): string => numbers[input.blocks.indexOf(block)] ?? ''
  const finished = upNextIsFinished(input.header.state)
  // A finished run has no queue: a stage it never reached is history, not work still to come.
  const planned = finished
    ? []
    : input.blocks.filter((block) => PLANNED.includes(block.state) && !upNextIsStoppedStage(block))
  const stages = planned.filter((block): block is UpNextAgentBlock => block.kind === 'agent')
  const seats = (block: UpNextAgentBlock): number => (block.shape === 'solo' ? 1 : block.n)
  const widest = stages.reduce<UpNextAgentBlock | null>(
    (champion, block) => (seats(block) > (champion ? seats(champion) : 1) ? block : champion),
    null
  )
  const live = input.blocks.find(
    (block): block is UpNextAgentBlock => block.kind === 'agent' && block.state === 'running'
  )
  const finishedAgents = input.blocks.filter(
    (block): block is UpNextAgentBlock => block.kind === 'agent'
  )
  return {
    stages: stages.length,
    executions: stages.reduce((total, block) => total + upNextStageExecutions(block), 0),
    perStage: stages.map((block) => ({
      number: number(block),
      template: block.template,
      executions: upNextStageExecutions(block)
    })),
    prompts: planned.filter((block) => block.kind === 'prompt').length,
    people: planned.filter((block) => block.kind === 'person').length,
    maxConcurrency: widest ? widest.n : 1,
    ...(widest ? { maxConcurrencyStage: number(widest) } : {}),
    ...startClause(input, live ? number(live) : undefined),
    ...(live
      ? {
          live: {
            stageN: Number(number(live).split('.')[0] ?? 0),
            stageOf: topLevel,
            template: live.template,
            seatsDone: (live.progress?.seats ?? []).filter((seat) => seat.state === 'done').length,
            seatsTotal: live.progress?.seats?.length ?? live.n,
            elapsedMs: live.progress?.elapsedMs ?? 0
          }
        }
      : {}),
    ...(finished
      ? {
          finished: {
            stages: finishedAgents.length,
            executions: finishedAgents.reduce(
              (total, block) => total + upNextStageExecutions(block),
              0
            ),
            durationMs: finishedAgents.reduce(
              (total, block) => total + (block.progress?.durationMs ?? 0),
              0
            ),
            doneWhenMet: input.doneWhen?.met ?? 0,
            doneWhenTotal: input.doneWhen?.total ?? 0
          }
        }
      : {})
  }
}
