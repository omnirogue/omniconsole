/** Descriptive scope from the original request; never an execution plan or completion claim. */
export type SessionMission = {
  title: string
  summary: string
  deliverables: { id: string; ordinal: number; title: string; description: string }[]
}

const MAX_REQUEST = 32_000
const MAX_DELIVERABLES = 24
const clean = (text: string): string => text.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()

/** Only an explicitly named mission list is scope; arbitrary numbered instructions are not. */
export function sessionMissionFromPrompt(prompt: string): SessionMission | undefined {
  const source = prompt.slice(0, MAX_REQUEST)
  const section =
    /^#{1,3}\s+(?:the\s+)?(?:\w+\s+)?(?:PRs|deliverables|mission stages)\b[^\n]*\n([\s\S]*?)(?=^#{1,3}\s|$(?![\s\S]))/im.exec(
      source
    )
  if (!section) {
    return undefined
  }
  const rows = [
    ...section[1].matchAll(
      /^\s*(\d+)[.)]\s+\*\*([^*\n]+)\*\*\s*([^\n]*(?:\n(?!\s*\d+[.)]\s|#{1,3}\s)[^\n]*)*)/gm
    )
  ]
  if (rows.length < 2 || rows.length > MAX_DELIVERABLES) {
    return undefined
  }
  if (rows.some((row, index) => Number(row[1]) !== index + 1)) {
    return undefined
  }
  const heading = /^#\s+(.+)$/m.exec(source)?.[1]
  if (!heading) {
    return undefined
  }
  const title = clean(heading)
    .replace(/^(?:build|implement|create):\s*/i, '')
    .replace(/\s*\([^)]*\bPRs?\)\s*$/i, '')
  const summary = source
    .split(/\n/)
    .filter((line) => /^-\s+A (?:workspace|folder workspace)\b/i.test(line))
    .map((line) => clean(line.replace(/^-\s*/, '')))
    .join(' ')
    .slice(0, 360)
  return {
    title: title.slice(0, 140),
    summary,
    deliverables: rows.map((row) => ({
      id: `mission-${row[1]}`,
      ordinal: Number(row[1]),
      title: clean(row[2]).replace(/[.:]$/, '').slice(0, 100),
      description: clean(row[3]).slice(0, 1_000)
    }))
  }
}
