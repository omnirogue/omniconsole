import type {
  Known,
  WorkflowJudgingGateRow,
  WorkflowJudgingGroup,
  WorkflowJudgingSeat,
  WorkflowJudgingStats,
  WorkflowJudgingSum,
  WorkflowJudgingTokens,
  WorkflowDiscoverDecisions
} from '../shared/workflow-judging-stats'

/** The judging stats as a person reads them: plain words, and "unknown" wherever the record is silent. */

const number = (value: number) => value.toLocaleString('en-US')

const plural = (count: number, one: string, many = `${one}s`) =>
  `${number(count)} ${count === 1 ? one : many}`

const when = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')

function tokens(value: Known<WorkflowJudgingTokens>, of: number): string {
  if (value === 'unknown') {
    return 'unknown'
  }
  const over = value.rounds === of ? '' : ` over ${value.rounds} of ${of}`
  return `${number(value.input)} in, ${number(value.output)} out${over}`
}

function usd(value: Known<number>): string {
  return value === 'unknown' ? 'unknown' : `$${value.toFixed(4)}`
}

function seconds(value: Known<WorkflowJudgingSum>, of: number): string {
  if (value === 'unknown') {
    return 'unknown'
  }
  const over = value.rounds === of ? '' : ` over ${value.rounds} of ${of}`
  return `${(value.total / 1000).toFixed(1)} s${over}`
}

function counts(table: Record<string, number>, none = 'none'): string {
  const entries = Object.entries(table).sort((left, right) => right[1] - left[1])
  return entries.length ? entries.map(([key, count]) => `${key} ${number(count)}`).join(', ') : none
}

function decisionLabel(group: WorkflowJudgingGroup): string {
  const { decision } = group
  if (decision === 'unknown') {
    return 'decided by: unknown'
  }
  return 'contract' in decision
    ? `contract ${decision.contract}`
    : `rubric ${decision.rubricDigest}`
}

const judges = (group: WorkflowJudgingGroup) =>
  group.judgedBy === 'jev'
    ? 'JEV'
    : group.judgedBy === 'models'
      ? 'the model judges'
      : 'JEV and the model judges'

function groupLines(group: WorkflowJudgingGroup): string[] {
  const rounds = group.rounds
  const agreement =
    group.agreement === 'unknown'
      ? 'Top agreement (hard rounds only): unknown.'
      : `Top agreement (hard rounds only): JEV and the models put the same answer first in ${group.agreement.topSame} of ${plural(group.agreement.rounds, 'hard round')}.`
  return [
    `${group.template} · ${group.stepId} · judged by ${judges(group)} · ${decisionLabel(group)}`,
    `  Rounds: ${number(rounds)}. Wins: ${counts(group.wins)}. Incumbent defences: ${number(group.defences)}.`,
    `  JEV alone ${number(group.jev.alone)}, escalated ${number(group.jev.escalated)}, failed ${group.jev.failed === 'unknown' ? 'unknown' : number(group.jev.failed)}, counted while unsure ${number(group.jev.countedWhileUnsure)}.`,
    `  ${agreement}`,
    `  JEV tokens: ${tokens(group.jevTokens, rounds)}. JEV cost: ${usd(group.jevUsd)}. JEV time: ${seconds(group.jevMs, rounds)}. Model judge calls: ${number(group.modelJudgeCalls)}.`,
    `  First ${when(group.first)}, last ${when(group.last)}.`
  ]
}

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length))
  )
  return rows.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join('  ')
      .trimEnd()
  )
}

function seatLines(seats: WorkflowJudgingSeat[]): string[] {
  if (!seats.length) {
    return ['No seats recorded.']
  }
  return table([
    ['model family', 'model', 'system prompt', 'entered', 'wins', 'defences'],
    ...seats.map((seat) => [
      seat.route,
      seat.model,
      seat.systemDigest,
      number(seat.entered),
      number(seat.wins),
      number(seat.defences)
    ])
  ]).map((line) => `  ${line}`)
}

function gateLines(gate: WorkflowJudgingGateRow): string[] {
  const contract = gate.contract === 'unknown' ? 'contract unknown' : `contract ${gate.contract}`
  return [
    `${gate.template} · ${gate.stepId} · ${gate.gate} · ${contract}`,
    `  Decided ${plural(gate.count, 'time')}: ${counts(gate.decisions)}. JEV failed ${number(gate.jevFailed)}.${gate.jevRefuted !== undefined ? ` JEV set aside ${plural(gate.jevRefuted, 'item')} the reviewers left unverified.` : ''}${gate.jevConfirmed !== undefined ? ` JEV confirmed ${plural(gate.jevConfirmed, 'item')} the reviewers left unverified.` : ''}`,
    `  JEV tokens: ${tokens(gate.jevTokens, gate.count)}. JEV cost: ${usd(gate.jevUsd)}. JEV time: ${seconds(gate.jevMs, gate.count)}.`
  ]
}

function sourceLine(source: WorkflowJudgingStats['source']): string {
  const parts = [
    `${plural(source.lines, 'line')} read from ${source.file}`,
    `${number(source.matched)} kept`,
    ...(source.skipped ? [`${number(source.skipped)} could not be read`] : []),
    ...(source.duplicates ? [`${number(source.duplicates)} repeated`] : []),
    ...(source.joined
      ? [
          `${number(source.joined)} older ${source.joined === 1 ? 'line' : 'lines'} filled in from the run's ballots`
        ]
      : [])
  ]
  return `${parts.join('; ')}.`
}

function decisionLines(decisions: WorkflowDiscoverDecisions): string[] {
  if (!decisions.runs) {
    return ['', 'No answered Discover pages recorded.']
  }
  const { start, dig, notNow } = decisions.picks
  const rate =
    decisions.actedOnRate === 'unknown' ? 'unknown' : `${Math.round(decisions.actedOnRate * 100)}%`
  return [
    '',
    `${plural(decisions.runs, 'answered page')}: ${number(start)} Start, ${number(dig)} Dig deeper, ${number(notNow)} Not now.`,
    `Acted on: ${rate} of picks; ${number(decisions.launched)} with a launch receipt.`
  ]
}

export function formatWorkflowJudgingStats(stats: WorkflowJudgingStats): string {
  const sections = [
    [
      stats.note,
      sourceLine(stats.source),
      `JEV price: ${stats.tariff.model} at $${stats.tariff.inputUsdPerMillion} per million input tokens and $${stats.tariff.outputUsdPerMillion} per million output tokens.`
    ],
    [
      'Rounds, by step and who judged',
      ...(stats.groups.length
        ? stats.groups.flatMap((group) => ['', ...groupLines(group)])
        : ['', 'No judged rounds recorded.'])
    ],
    ...(stats.discover
      ? [
          [
            `Discover: ${stats.discover.runs} runs; unreadable ${stats.discover.unreadable}.`,
            `  States: ${counts(stats.discover.outcomes.states)}. Delivery: ${counts(stats.discover.outcomes.delivery)}.`,
            `  Degraded ${stats.discover.outcomes.degraded}; substitutions ${stats.discover.outcomes.substitutions}.`,
            ...stats.discover.rounds.map(
              (row) =>
                `  Round ${row.round}: ${row.newFindings} new, ${row.confirmed} confirmed over ${row.runs} runs.`
            ),
            ...stats.discover.steps.map(
              (row) =>
                `  ${row.stepRound}: ${usd(row.costUsd)}${row.partial ? ' (partial)' : ''}; ${row.unknownCalls} calls unpriced.`
            ),
            `  ${stats.discover.precisionNote}`
          ]
        ]
      : []),
    ['Seats', ...seatLines(stats.seats)],
    [
      'Gates',
      ...(stats.gates.length
        ? stats.gates.flatMap((gate) => ['', ...gateLines(gate)])
        : ['', 'No gates recorded.'])
    ],
    ...(stats.decisions ? [['Discover decisions', ...decisionLines(stats.decisions)]] : [])
  ]
  return sections.map((lines) => lines.join('\n')).join('\n\n')
}
