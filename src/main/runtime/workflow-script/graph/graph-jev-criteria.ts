/** Which candidate leads each criterion; ties within 0.15 share the lead. */
export function criterionLeaderLines(
  labels: readonly string[],
  criteria: readonly { label: string }[],
  scores: readonly (readonly (number | undefined)[])[]
): string[] {
  const lines = criteria.flatMap((criterion, column) => {
    const scored = scores.map((row) => row[column]).filter((v): v is number => v !== undefined)
    if (!scored.length) {
      return []
    }
    const best = Math.max(...scored)
    const leaders = labels.filter((_, index) => {
      const score = scores[index]?.[column]
      return score !== undefined && score >= best - 0.15
    })
    return [`- ${criterion.label}: ${leaders.join(', ')} (${best.toFixed(2)})`]
  })
  return lines.length
    ? ['Criterion leaders (for a synthesis, take each part from its leader):', ...lines]
    : []
}
