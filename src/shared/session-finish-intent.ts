import { z } from 'zod'

/**
 * How this session finishes once its Outcome is met. `save` keeps it in a folder, so the
 * FOLDER is part of the choice: the Done block's "Save to …" is a host fact, not a
 * presentation detail, and a restart or another device shows the same destination.
 * `me` (the legacy completion choice) is legacy — kept so an old chain still loads, never emitted.
 */
export const sessionFinishChoiceSchema = z
  .object({
    action: z.enum(['me', 'save', 'end']),
    folderId: z.string().min(1).max(200).optional()
  })
  .strict()
export type SessionFinishChoice = z.infer<typeof sessionFinishChoiceSchema>

/** Only a direct instruction about this session can authorize its later disposition. */
export function requestedSessionFinish(prompt: string): SessionFinishChoice | undefined {
  const direct = prompt
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' [context] ')
    .replace(/<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g, ' [context] ')
    .replace(/`[^`]*`|"[^"]*"|“[^”]*”|‘[^’]*’|(?:^|\s)'[^'\n]+'(?=\s|[.!?,;]|$)/g, ' [context] ')
    .replace(/^\s*>.*$/gm, ' [context] ')
  // Discussion and conditional suggestions do not authorize closing work.
  if (
    /\b(?:example|quoted?|hypothetical|pretend|someone said|told me|instruction says|consider|suggest|if you|if i)\b/i.test(
      direct
    )
  ) {
    return undefined
  }
  if (
    /\b(?:do not|don't|not|never|without)\b[^.!;\n]*\b(?:save|saved|close|end)\b[^.!;\n]*\bsession\b/i.test(
      direct
    )
  ) {
    return undefined
  }
  const timing =
    "(?:when|once|after) (?:(?:(?:it(?:'s| is)|you(?:'re| are)|the work is) )?(?:done|finished|complete|completed)|(?:it|this session|the session|the work) (?:finishes|completes|has finished|has completed))"
  const polite =
    /^(?:please\s+)?(?:can|could|would|will) you (?:please )?(?:save|close|end|mark|keep|send|review)\b/i.test(
      direct.trim()
    )
  const actions: SessionFinishChoice['action'][] = []
  // ", then close this session" is its own clause: a wait plan ends that way (Sal, 2026-09-24).
  for (const part of direct.split(/[.;!\n]|\s+and\s+|,\s*(?:and\s+)?then\s+/i)) {
    const directRequest = /^(?:please\s+)?(?:can|could|would|will) you\s+/i.test(part.trim())
    const clause = part
      .trim()
      .toLowerCase()
      .replace(/^(?:please\s+)?(?:can|could|would|will) you\s+/, '')
      .replace(/\?$/, (question) => (directRequest || polite ? '' : question))
      .replace(new RegExp(`^(?:please\\s+|then\\s+|${timing},?\\s*)+`), '')
      .replace(new RegExp(`\\s+(?:${timing}|on completion)$`), '')
    if (
      /^(?:save (?:this|the|my) session|mark (?:this|the|my) session (?:as )?saved)$/.test(clause)
    ) {
      actions.push('save')
    } else if (/^(?:close(?: out)?|end) (?:this|the|my) session$/.test(clause)) {
      actions.push('end')
    } else if (/^keep (?:this|the|my) session (?:open|for me)$/.test(clause)) {
      actions.push('me')
    }
  }
  return actions.length && new Set(actions).size === 1 ? { action: actions[0]! } : undefined
}

export function assertSessionFinishIntent(choice: SessionFinishChoice, prompt: string): void {
  if (requestedSessionFinish(prompt)?.action !== choice.action) {
    throw new Error('The attested user request must explicitly say how this session should finish.')
  }
}
