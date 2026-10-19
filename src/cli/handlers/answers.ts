import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ANSWER_DELIVERY_PILOT_FILE,
  summarizeAnswerDeliveryPilot,
  type AnswerDeliveryPilotReport
} from '../../shared/answer-delivery-pilot-report'
import { parseSinceDuration } from '../../shared/session-organization-readers'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getDefaultUserDataPath } from '../runtime/metadata'

const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000

function readPilotLines(userDataPath: string): string {
  const file = join(userDataPath, ANSWER_DELIVERY_PILOT_FILE)
  return [`${file}.1`, file]
    .map((path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return ''
      }
    })
    .join('\n')
}

const rate = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)}%`)
const seconds = (ms: number | null) => (ms === null ? '-' : `${Math.round(ms / 1000)} s`)

export function formatAnswerPilotReport(report: AnswerDeliveryPilotReport): string {
  const paths = Object.entries(report.byPath)
    .map(([path, count]) => `${path} ${count}`)
    .join(', ')
  return [
    `Answer delivery pilot since ${report.since}: ${report.deliveries} deliveries, ${report.open} open`,
    `By path: ${paths || 'none'}`,
    `Claim to confirmation: p50 ${seconds(report.latencyMs.p50)}, p95 ${seconds(report.latencyMs.p95)} (${report.latencyMs.samples} confirmed)`,
    `Fallback rate ${rate(report.fallbackRate)}; confirmed within 5 min ${rate(report.confirmedWithin5mRate)}; median attempts ${report.medianAttempts ?? '-'}`
  ].join('\n')
}

export function answerPilotReport(
  flags: Map<string, string | boolean>,
  userDataPath: string,
  now: number = Date.now()
): AnswerDeliveryPilotReport {
  const raw = getOptionalStringFlag(flags, 'since')
  const window = raw === undefined ? DEFAULT_SINCE_MS : parseSinceDuration(raw)
  if (window === null) {
    throw new RuntimeClientError('invalid_argument', '--since takes a window like 30m, 24h or 7d.')
  }
  return summarizeAnswerDeliveryPilot(readPilotLines(userDataPath), now - window)
}

export const ANSWERS_HANDLERS: Record<string, CommandHandler> = {
  'answers pilot-report': async ({ flags, json }) => {
    const report = answerPilotReport(flags, getDefaultUserDataPath())
    printResult(
      { id: 'local', ok: true, result: report, _meta: { runtimeId: 'local' } },
      json,
      formatAnswerPilotReport
    )
  }
}
