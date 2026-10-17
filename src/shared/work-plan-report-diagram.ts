import type { WorkPlanReportSeat, WorkPlanReportStage } from './work-plan-report-topology'

/** XML text escape. The diagram carries agent prompts, so every value is escaped, always. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const COLUMN = 210
const SEAT_WIDTH = 168
const SEAT_HEIGHT = 46
const SEAT_GAP = 14
const TOP = 68
const LEFT = 20

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Everything a person wants on hover, in the order they ask for it. */
function seatMetadata(seat: WorkPlanReportSeat): string {
  return [
    `${seat.actor}${seat.model ? ` · ${seat.model}` : ''}${seat.effort ? ` · effort ${seat.effort}` : ''}`,
    `state: ${seat.state}`,
    seat.rounds ?? null,
    seat.verdict ? `verdict: ${seat.verdict}` : null,
    seat.verdictReceipt ? `receipt: ${seat.verdictReceipt}` : null,
    seat.launchedAt ? `launched: ${new Date(seat.launchedAt).toISOString()}` : null,
    `instruction: ${clip(seat.instruction, 400)}`
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
}

function seatShape(seat: WorkPlanReportSeat, x: number, y: number): string {
  return [
    `<g class="seat seat-${seat.state}">`,
    `<title>${escapeXml(seatMetadata(seat))}</title>`,
    `<rect x="${x}" y="${y}" width="${SEAT_WIDTH}" height="${SEAT_HEIGHT}" rx="6" />`,
    `<text class="seat-actor" x="${x + 10}" y="${y + 19}">${escapeXml(clip(seat.actor, 22))}</text>`,
    `<text class="seat-model" x="${x + 10}" y="${y + 36}">${escapeXml(
      clip(seat.model ?? seat.state, 26)
    )}</text>`,
    '</g>'
  ].join('')
}

/**
 * The chain as it is running, drawn from runtime state: one column per stage, one box per seat,
 * `⑂N` where seats run together and `→` where one stage waits on the last. Hover metadata rides on
 * `<title>` so the diagram needs no script — the report opens in a sandboxed viewer and in a browser
 * alike, and carries no reference to anything off the disk it sits on.
 */
export function workPlanTopologySvg(stages: WorkPlanReportStage[]): string {
  const widest = Math.max(1, ...stages.map((stage) => stage.seats.length))
  const width = LEFT * 2 + Math.max(1, stages.length) * COLUMN
  const height = TOP + widest * (SEAT_HEIGHT + SEAT_GAP) + 12
  const parts: string[] = []
  for (const [index, stage] of stages.entries()) {
    const x = LEFT + index * COLUMN
    const label = `${stage.glyph ? `${stage.glyph} ` : ''}${stage.title}${
      stage.parallel ? ` ⑂${stage.seats.length}` : ''
    }`
    parts.push(
      `<g class="stage${stage.current ? ' stage-current' : ''}">`,
      `<title>${escapeXml(
        `${stage.title} · ${stage.parallel ? `${stage.seats.length} seats in parallel` : 'one seat'}${
          stage.current ? ' · running now' : ''
        }`
      )}</title>`,
      `<text class="stage-title" x="${x}" y="34">${escapeXml(clip(label, 24))}</text>`,
      stage.current
        ? `<rect class="stage-mark" x="${x}" y="44" width="${SEAT_WIDTH}" height="4" />`
        : '',
      '</g>'
    )
    for (const [seatIndex, seat] of stage.seats.entries()) {
      parts.push(seatShape(seat, x, TOP + seatIndex * (SEAT_HEIGHT + SEAT_GAP)))
    }
    if (index + 1 < stages.length) {
      const from = x + SEAT_WIDTH
      const y = TOP + SEAT_HEIGHT / 2
      parts.push(
        `<path class="flow" d="M ${from} ${y} L ${from + (COLUMN - SEAT_WIDTH)} ${y}" />`,
        `<text class="flow-glyph" x="${from + 12}" y="${y - 6}">→</text>`
      )
    }
  }
  return [
    `<svg class="topology" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Plan topology">`,
    `<title>Plan topology: ${stages.length} stages</title>`,
    ...parts.filter(Boolean),
    '</svg>'
  ].join('\n')
}
