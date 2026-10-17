/** One run of a live tail's text: plain, bold (a `**bold**` span or a heading) or inline code. */
export type LiveTailSegment = { text: string; style?: 'strong' | 'code'; offset: number }

const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/
const INLINE = /\*\*([^*\n]+?)\*\*|`([^`\n]+)`/g
/** A line still inside a bold span: its closing `**` has not streamed in yet. */
const OPEN_BOLD = /^\*\*([^*]+)$/
/** The first line of a tail cut inside a bold span: only its closing `**` is left. */
const CUT_BOLD = /^([^*]+)\*\*$/

/**
 * The lines of a bold span the model wrapped: from a line that opens `**` to a later one that
 * closes it, with no other `*` and no blank line between. Its first line alone would already read
 * as bold (OPEN_BOLD); the rest need the span to read theirs.
 */
function wrappedBoldLines(lines: readonly string[]): Set<number> {
  const inside = new Set<number>()
  let opened = -1
  lines.forEach((line, index) => {
    if (opened !== -1 && CUT_BOLD.test(line)) {
      for (let at = opened; at <= index; at += 1) {
        inside.add(at)
      }
      opened = -1
    } else if (OPEN_BOLD.test(line)) {
      opened = index
    } else if (!line.trim() || line.includes('*')) {
      opened = -1
    }
  })
  return inside
}

/**
 * A live tail is the last ~2 KB of what an agent is writing, usually cut mid-sentence, and Codex
 * writes its reasoning headings as `**bold**` lines. Full markdown would misread such a fragment,
 * so only light marks are read: `**bold**` spans, `# headings` (as bold lines) and `code` spans.
 * A marker the cut or the stream left without its partner is dropped instead of shown, and a bold
 * span the model wrapped over lines reads as bold on each; one in the middle of a line (a glob such
 * as `src/**` or `2**10`) is kept as written. A span holding a `*` of its own (`**a*b**`) is left
 * as written too: reading it would also read two globs on one line as one bold span.
 */
export function liveTailSegments(tail: string): LiveTailSegment[] {
  const segments: LiveTailSegment[] = []
  let offset = 0
  const push = (text: string, style?: LiveTailSegment['style']) => {
    if (!text) {
      return
    }
    const last = segments.at(-1)
    if (last && last.style === style) {
      last.text += text
    } else {
      segments.push({ text, offset, ...(style ? { style } : {}) })
    }
    offset += text.length
  }
  const lines = tail.split('\n')
  const wrapped = wrappedBoldLines(lines)
  lines.forEach((line, index) => {
    const whole =
      HEADING.exec(line)?.[1] ??
      (wrapped.has(index) ? line : undefined) ??
      OPEN_BOLD.exec(line)?.[1] ??
      (index === 0 ? CUT_BOLD.exec(line)?.[1] : undefined)
    if (whole !== undefined) {
      push(whole.replaceAll('**', ''), 'strong')
    } else {
      let from = 0
      for (const match of line.matchAll(INLINE)) {
        push(line.slice(from, match.index))
        push(match[1] ?? match[2], match[1] === undefined ? 'code' : 'strong')
        from = match.index + match[0].length
      }
      push(line.slice(from))
    }
    if (index < lines.length - 1) {
      push('\n')
    }
  })
  return segments
}
