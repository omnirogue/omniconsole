import {
  WORKFLOW_MAX_PATIENCE,
  WORKFLOW_MAX_POPULATION,
  type WorkflowRepeat
} from './workflow-graph'

/** An Improve loop's own settings; a kept-back case the practice also shows is warned about. */
export function validateImproveRepeat(
  repeat: WorkflowRepeat,
  problem: (message: string) => void,
  warn: (message: string) => void = () => {}
): void {
  if (
    repeat.patience !== undefined &&
    (repeat.patience < 1 || repeat.patience > WORKFLOW_MAX_PATIENCE)
  ) {
    problem(`Stop after 1 to ${WORKFLOW_MAX_PATIENCE} rounds without improvement.`)
  }
  if (
    repeat.population !== undefined &&
    (!Number.isInteger(repeat.population) ||
      repeat.population < 1 ||
      repeat.population > WORKFLOW_MAX_POPULATION)
  ) {
    problem(`Build on 1 to ${WORKFLOW_MAX_POPULATION} versions each round.`)
  }
  const check = repeat.check
  if (check && check.command.includes('{case}') && !check.cases?.length) {
    problem('The test command uses {case}: add at least one practice case, one per line.')
  }
  const sealed = check?.sealed
  if (!check || !sealed) {
    return
  }
  const sealedCommand = sealed.command ?? check.command
  if (sealedCommand.includes('{case}') && !sealed.cases?.length) {
    problem('The final test uses {case}: add at least one kept-back case, one per line.')
  }
  const practice = new Set((check.cases ?? []).map((line) => line.trim()))
  // Named by number, never quoted: a warning may be shown where the case itself should not be.
  const seen = (sealed.cases ?? []).flatMap((line, index) =>
    practice.has(line.trim()) ? [index + 1] : []
  )
  if (seen.length) {
    const which =
      seen.length === 1
        ? `Kept-back case ${seen[0]} is also a practice case`
        : `Kept-back cases ${seen.join(', ')} are also practice cases`
    warn(
      `${which}, so the AIs see ${seen.length === 1 ? 'it' : 'them'}. The final test is only fair on cases they never saw.`
    )
  }
}
