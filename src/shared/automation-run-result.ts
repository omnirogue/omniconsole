/** Missing or malformed notability is notable, so useful results are never silently suppressed. */
export function automationRunResult(content: string): {
  notable: boolean
  summary: string
  output: string
} {
  const metadata = /```routine-result\s*\n([\s\S]*?)\n```\s*$/.exec(content)
  let notable = true
  let summary = ''
  if (metadata) {
    try {
      const parsed: unknown = JSON.parse(metadata[1])
      if (parsed && typeof parsed === 'object') {
        if ('notable' in parsed && parsed.notable === false) {
          notable = false
        }
        if ('summary' in parsed && typeof parsed.summary === 'string') {
          summary = parsed.summary
        }
      }
    } catch {
      /* Invalid metadata must not suppress an alert. */
    }
  }
  const output = metadata ? content.slice(0, metadata.index).trimEnd() : content
  return {
    notable,
    summary: (summary || output.split('\n').find((line) => line.trim()) || 'Routine finished')
      .replace(/\s+/g, ' ')
      .slice(0, 280),
    output
  }
}
