/**
 * What JEV judges by. A rubric is plain text: what good means for this task. Two or more bulleted
 * lines are scored as separate criteria, so a synthesis can take each part from its leader and a
 * person can see which criterion decided the ranking. Without bullets, five general criteria apply.
 */
export type JevCriterion = { id: string; label: string; question: string }

export const JEV_DEFAULT_RUBRIC =
  'Judge which response best does what the task asks: correct, complete, clear, and ready to use.'

const DEFAULT_CRITERIA: readonly JevCriterion[] = [
  {
    id: 'task_fit',
    label: 'task fit',
    question: 'Does it do what the task asks, fully and correctly?'
  },
  {
    id: 'evidence',
    label: 'evidence',
    question: 'Are its claims supported by evidence, sources or checks?'
  },
  {
    id: 'completeness',
    label: 'completeness',
    question: 'Does it cover everything the task needs, with nothing important missing?'
  },
  { id: 'clarity', label: 'clarity', question: 'Is it clear, well organized and ready to use?' },
  {
    id: 'insight',
    label: 'insight',
    question: 'Does it contain a non-obvious idea or approach that others would miss?'
  }
]

const MAX_CRITERIA = 12

/** The bulleted criteria a rubric lists (two or more), else the general defaults. */
export function jevCriteria(rubric: string): readonly JevCriterion[] {
  const bullets = rubric
    .split('\n')
    .map((line) => /^\s*(?:[-*•]|\d+[.)])\s+(.{3,300})$/.exec(line)?.[1]?.trim())
    .filter((line): line is string => Boolean(line))
  if (bullets.length < 2) {
    return DEFAULT_CRITERIA
  }
  return bullets.slice(0, MAX_CRITERIA).map((question, index) => ({
    id: `c${index + 1}`,
    label: question
      .split(/\s+/)
      .slice(0, 5)
      .join(' ')
      .replace(/[:?.,;]+$/, ''),
    question
  }))
}
