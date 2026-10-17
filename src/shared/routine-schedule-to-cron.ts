export const cronRefusals = {
  missing: 'This routine has no schedule. The server requires a cron schedule.',
  count: 'A fixed server clock cannot preserve a limited run count.',
  until: 'A fixed server clock cannot preserve an end date.',
  position: 'Nth-weekday and position-based schedules cannot be converted.',
  monthly: 'Monthly and day-of-month schedules cannot be converted.',
  yearly: 'Yearly schedules cannot be converted.',
  multiple: 'Multiple hours or minutes do not reduce to one fixed time.',
  minuteInterval: 'The minute interval is not a clean divisor of an hour.',
  hourInterval: 'The hour interval is not a clean divisor of a day.',
  dst: 'This schedule crosses a daylight-saving change; ask to run it at a fixed UTC time instead.',
  unknown: "This schedule doesn't reduce to something the server can run on a fixed clock."
} as const
export type CronRefusal = keyof typeof cronRefusals
export type CronConversionResult =
  | { ok: true; cron: string; localCron: string; utcSummary: string }
  | { ok: false; code: CronRefusal; reason: string }
const refuse = (code: CronRefusal): CronConversionResult => ({
  ok: false,
  code,
  reason: cronRefusals[code]
})
const days = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function clock(date: Date, timezone: string): { hour: number; minute: number; offset: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date)
  const value = (name: string): number => Number(parts.find((p) => p.type === name)?.value)
  const wall = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second')
  )
  return {
    hour: value('hour'),
    minute: value('minute'),
    offset: Math.round((wall - date.getTime()) / 60000)
  }
}

/** Strict lossless subset; the local parser tolerates fields that must not be silently dropped here. */
export function convertRruleToUtcCron(args: {
  rrule: string
  dtstart: number | string
  timezone?: string
  currentYear?: number
}): CronConversionResult {
  if (!args.rrule.trim()) {
    return refuse('missing')
  }
  const fields: Record<string, string> = {}
  for (const part of args.rrule
    .trim()
    .replace(/^RRULE:/i, '')
    .toUpperCase()
    .split(';')) {
    const match = /^([A-Z]+)=([^=]+)$/.exec(part)
    if (!match || fields[match[1]] !== undefined) {
      return refuse('unknown')
    }
    fields[match[1]] = match[2]
  }
  if ('COUNT' in fields) {
    return refuse('count')
  }
  if ('UNTIL' in fields) {
    return refuse('until')
  }
  if ('BYSETPOS' in fields) {
    return refuse('position')
  }
  if ('BYMONTHDAY' in fields || fields.FREQ === 'MONTHLY') {
    return refuse('monthly')
  }
  if (fields.FREQ === 'YEARLY') {
    return refuse('yearly')
  }
  for (const key of ['BYHOUR', 'BYMINUTE']) {
    if (fields[key]?.includes(',')) {
      const values = [...new Set(fields[key].split(','))]
      if (values.length !== 1) {
        return refuse('multiple')
      }
      fields[key] = values[0]
    }
  }
  if (
    Object.keys(fields).some(
      (key) => !['FREQ', 'INTERVAL', 'BYHOUR', 'BYMINUTE', 'BYDAY'].includes(key)
    )
  ) {
    return refuse('unknown')
  }
  const { FREQ: freq, BYDAY: byday } = fields
  if (!['MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY'].includes(freq)) {
    return refuse('unknown')
  }
  const integer = (value: string): number => (/^\d+$/.test(value) ? Number(value) : Number.NaN)
  const interval = integer(fields.INTERVAL ?? '1')
  if (!Number.isSafeInteger(interval) || interval < 1) {
    return refuse('unknown')
  }
  const success = (cron: string, localCron = cron): CronConversionResult => ({
    ok: true,
    cron,
    localCron,
    utcSummary: `${cron} (UTC)`
  })
  if (freq === 'MINUTELY') {
    if (fields.BYHOUR || fields.BYMINUTE || byday) {
      return refuse('unknown')
    }
    return 60 % interval === 0 ? success(`*/${interval} * * * *`) : refuse('minuteInterval')
  }
  if (freq === 'HOURLY' && 24 % interval !== 0) {
    return refuse('hourInterval')
  }
  if ((freq === 'DAILY' || freq === 'WEEKLY') && interval !== 1) {
    return refuse('unknown')
  }
  if (byday && freq !== 'WEEKLY') {
    return refuse('unknown')
  }
  if (freq === 'HOURLY' && fields.BYHOUR) {
    return refuse('unknown')
  }
  try {
    // Numeric dtstart is the persisted epoch; offset-bearing ISO is supported for callers/tests.
    if (typeof args.dtstart === 'string' && !/(Z|[+-]\d\d:\d\d)$/i.test(args.dtstart)) {
      return refuse('unknown')
    }
    const date = new Date(args.dtstart)
    if (!Number.isFinite(date.getTime())) {
      return refuse('unknown')
    }
    const zone = args.timezone ?? 'UTC'
    let local = clock(date, zone)
    if (!args.timezone && typeof args.dtstart === 'string') {
      const offset = /([+-])(\d\d):(\d\d)$/.exec(args.dtstart)
      if (offset) {
        const minutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '+' ? 1 : -1)
        const wall = new Date(date.getTime() + minutes * 60000)
        local = {
          hour: wall.getUTCHours(),
          minute: wall.getUTCMinutes(),
          offset: minutes
        }
      }
    }
    const hour = fields.BYHOUR === undefined ? local.hour : integer(fields.BYHOUR)
    const minute = fields.BYMINUTE === undefined ? local.minute : integer(fields.BYMINUTE)
    if (!Number.isInteger(hour) || hour > 23 || !Number.isInteger(minute) || minute > 59) {
      return refuse('unknown')
    }
    const utcMinutes = hour * 60 + minute - local.offset
    const minuteUtc = ((utcMinutes % 60) + 60) % 60
    if (freq === 'HOURLY') {
      return success(`${minuteUtc} */${interval} * * *`, `${minute} */${interval} * * *`)
    }
    const year = args.currentYear ?? new Date().getUTCFullYear()
    if (
      clock(new Date(Date.UTC(year, 0, 1)), zone).offset !==
      clock(new Date(Date.UTC(year, 6, 1)), zone).offset
    ) {
      return refuse('dst')
    }
    const hourUtc = Math.floor((((utcMinutes % 1440) + 1440) % 1440) / 60)
    if (freq === 'DAILY') {
      return success(`${minuteUtc} ${hourUtc} * * *`, `${minute} ${hour} * * *`)
    }
    const localDays = byday?.split(',') ?? []
    if (!localDays.length || localDays.some((day) => !days.includes(day))) {
      return refuse('unknown')
    }
    const shift = Math.floor(utcMinutes / 1440)
    const utcDays = [...new Set(localDays.map((day) => (days.indexOf(day) + shift + 7) % 7))].sort()
    return success(
      `${minuteUtc} ${hourUtc} * * ${utcDays.join(',')}`,
      `${minute} ${hour} * * ${localDays.map((day) => days.indexOf(day)).join(',')}`
    )
  } catch {
    return refuse('unknown')
  }
}
