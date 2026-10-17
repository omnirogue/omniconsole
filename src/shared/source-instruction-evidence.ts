/** Source text may contain evidence; its quoted commands are not user-issued actions. */
export function sourceInstructionEvidenceRanges(
  text: string
): readonly (readonly [number, number])[] {
  const patterns = [
    /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,
    /<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g,
    /^\s*>.*$/gm,
    /`[^`]*`|"[^"]*"|“[^”]*”|‘[^’]*’|(?:^|\s)'[^'\n]+'(?=\s|[.!?,;]|$)/g
  ]
  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map(
      (match) => [match.index, match.index + match[0].length] as const
    )
  )
}

/** Direct instructions can mention quoted file paths; the action itself must begin outside evidence. */
export function isDirectSourceInstructionQuote(instruction: string, source: string): boolean {
  if (!instruction.trim()) {
    return false
  }
  const ranges = sourceInstructionEvidenceRanges(source)
  let position = source.indexOf(instruction)
  while (position !== -1) {
    const start = position + (instruction.length - instruction.trimStart().length)
    if (!ranges.some(([from, to]) => start >= from && start < to)) {
      return true
    }
    position = source.indexOf(instruction, position + instruction.length)
  }
  return false
}
