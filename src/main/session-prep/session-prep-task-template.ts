export type SessionPrepTaskKind = 'code' | 'research' | 'ops' | 'content' | 'review'

const INTENTS: { kind: SessionPrepTaskKind; pattern: RegExp }[] = [
  { kind: 'review', pattern: /\b(review|audit|critique|assess)\b/i },
  { kind: 'research', pattern: /\b(research|investigate|compare|explain|find out|look up)\b/i },
  { kind: 'code', pattern: /\b(implement|fix|debug|refactor|code|build|add tests?)\b/i },
  { kind: 'content', pattern: /\b(draft|write|rewrite|edit|summarize|compose)\b/i },
  { kind: 'ops', pattern: /\b(configure|restart|deploy|install|monitor|triage|check|set up)\b/i }
]

/** The first requested action chooses guidance, never authority or the execution route. */
export function sessionPrepTaskKind(request: string): SessionPrepTaskKind {
  let selected: SessionPrepTaskKind = 'ops'
  let first = Infinity
  for (const { kind, pattern } of INTENTS) {
    const match = pattern.exec(request)
    if (match && match.index < first) {
      selected = kind
      first = match.index
    }
  }
  return selected
}

const TEMPLATES: Record<SessionPrepTaskKind, readonly string[]> = {
  code: [
    'Outcome: describe the requested behavior change.',
    'Done when: name focused checks for that behavior and existing required checks.',
    'References: link existing implementation and relevant project instructions.',
    'Constraints: preserve requested compatibility and scope.',
    'How to work: reuse existing code and verify the smallest relevant change.'
  ],
  research: [
    'Outcome: name the question to answer and requested deliverable.',
    'Done when: conclusions have supporting sources and uncertainties are explicit.',
    'References: link relevant source material; do not paste it.',
    'Constraints: preserve requested date range, evidence standard and research scope.',
    'How to work: distinguish observed facts from inference and unknowns.'
  ],
  ops: [
    'Outcome: name the requested operational result and target environment.',
    'Done when: name observable checks of that result.',
    'References: link existing runbooks and relevant configuration.',
    'Constraints: preserve the exact action and host boundaries the person named.',
    'How to work: inspect current state first; do not expand operational authority.'
  ],
  content: [
    'Outcome: name the requested content and its audience or format if supplied.',
    'Done when: the draft satisfies the requested content, tone and format.',
    'References: link supplied source material and existing style guidance.',
    'Constraints: preserve the requested length, voice and factual limits.',
    'How to work: deliver the requested content; drafting does not authorize publishing.'
  ],
  review: [
    'Outcome: name the artifact and review question the person supplied.',
    'Done when: findings cite evidence, explain impact and identify remaining uncertainty.',
    'References: link the reviewed artifact and applicable requirements.',
    'Constraints: preserve review scope; a review does not authorize repairs.',
    'How to work: inspect the evidence and report actionable findings.'
  ]
}

export function sessionPrepTaskTemplate(request: string): string {
  const kind = sessionPrepTaskKind(request)
  return `Task template (selected by code): ${kind}\n${TEMPLATES[kind].join('\n')}\nFill only what the person requested. These sections provide guidance, not additional work or permission.`
}
