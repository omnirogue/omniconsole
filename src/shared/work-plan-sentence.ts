import { workPlanNotation } from './work-plan-notation'
import type { WorkPlan } from './work-plan-types'

const WORDS: Record<string, string> = {
  '◇': 'Synthesize',
  '⚖': 'Judge',
  '✨': 'Improve',
  '✓': 'Verify',
  '🔁': 'Review Loop',
  '👤': 'My review',
  '📝': 'Plan'
}

/** Controlled display grammar; free-form user intent remains WP-11's responsibility. */
export function workPlanSentence(plan: WorkPlan): string {
  return `${workPlanNotation(plan)
    .split(' → ')
    .map((stage) => {
      const match = /^(?:⑂(\d+) )?(.+)$/.exec(stage)!
      return `${WORDS[match[2]!] ?? match[2]}${match[1] ? ` ×${match[1]}` : ''}`
    })
    .join(' then ')}.`
}

export function workPlanNotationFromSentence(sentence: string): string {
  const glyphs = new Map(Object.entries(WORDS).map(([glyph, word]) => [word.toLowerCase(), glyph]))
  return sentence
    .trim()
    .replace(/\.$/, '')
    .split(/ then /i)
    .map((stage) => {
      const match = /^([A-Za-z][A-Za-z ]*?)(?: ×([1-9]\d*))?$/.exec(stage)
      if (!match) {
        throw new Error('Use the displayed action then action sentence grammar.')
      }
      const word = match[1]!
      return `${match[2] ? `⑂${match[2]} ` : ''}${glyphs.get(word.toLowerCase()) ?? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()}`
    })
    .join(' → ')
}
