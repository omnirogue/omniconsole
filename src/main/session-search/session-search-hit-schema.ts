import { z } from 'zod'
const text = (max: number) => z.string().transform((value) => value.slice(0, max))

// Why: a paired host is another installation with its own version; keep what parses, drop the rest.
export const remoteHitSchema = z.object({
  executionHostId: text(600).optional(),
  sessionKey: text(200),
  sessionId: text(200),
  agent: z.enum(['claude', 'codex']),
  title: text(300),
  cwd: text(2_000).nullable().catch(null),
  transcriptPath: text(4_000),
  lastActivityAt: z.number().nullable().catch(null),
  score: z.number(),
  match: z.enum(['title', 'text', 'meaning']).optional().catch(undefined),
  reasons: z.array(text(300)).max(12).catch([]),
  snippets: z
    .array(z.object({ role: z.enum(['user', 'assistant', 'tool']), text: text(1_000) }))
    .max(4)
    .catch([]),
  // Why 4,000: a stored summary with its Outcome and Links lines is at most SUMMARY_MAX_CHARS + 600
  // (about 3k), and a cut Links URL points nowhere; the omnios Work feed parses 4,000 too.
  summary: text(4_000).nullable().catch(null),
  summarySource: z.enum(['model', 'extractive']).nullable().catch(null)
})
