/**
 * Live replay of the next-step JEV questions (rank, risk, doneness) before they are trusted:
 * REPLAYS× over five fixed turns (two done, two not done, one risky). Needs TYPESAFE_API_KEY (env
 * or ~/.config/omni/connections.env); never prints it.
 *
 *   node_modules/.bin/jiti config/scripts/next-steps/probe-next-step-jev.ts [replays] [out.json]
 */
import { writeFileSync } from 'node:fs'
import { nextStepLooksDone, nextStepDonenessIsUnsure } from '../../../src/shared/next-step-doneness'
import type { NextStepSuggestion } from '../../../src/shared/next-step-suggestions'
import { nextStepRiskOf } from '../../../src/shared/next-step-suggestions'
import { nextStepTranscriptBlock } from '../../../src/shared/next-step-suggestion-prompt'
import { jevDecide } from '../../../src/main/structured-decisions/jev-rank'
import { resolveTypesafeCredential } from '../../../src/main/structured-decisions/decision-credential'
import {
  applyNextStepJudgement,
  buildNextStepJudgeRequest
} from '../../../src/main/next-steps/next-step-jev-rank'
import {
  buildNextStepDonenessRequest,
  readNextStepDoneness
} from '../../../src/main/next-steps/next-step-jev-doneness'
import { judgeNextStepImprovement } from '../../../src/main/next-steps/next-step-jev-improvement'
import { IMPROVEMENT_PAIRS, PUSH_PROMPT, SAMPLES, type Sample } from './probe-next-step-jev-samples'

const toSuggestions = (sample: Sample): NextStepSuggestion[] =>
  sample.steps.map(([title, prompt], index) => ({
    id: `s${index + 1}`,
    title,
    prompt,
    risk: nextStepRiskOf(`${title} ${prompt}`, 'safe'),
    kind: 'continue'
  }))

const stats = (values: number[]) => ({
  min: Math.min(...values),
  max: Math.max(...values),
  mean: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100
})

function mode<T>(values: T[]): { value: T; share: number } {
  const counts = new Map<string, { value: T; n: number }>()
  for (const value of values) {
    const key = JSON.stringify(value)
    const entry = counts.get(key) ?? { value, n: 0 }
    entry.n++
    counts.set(key, entry)
  }
  const top = [...counts.values()].sort((a, b) => b.n - a.n)[0]!
  return { value: top.value, share: top.n / values.length }
}

async function probeSample(sample: Sample, replays: number) {
  const suggestions = toSuggestions(sample)
  const judge = {
    turnText: nextStepTranscriptBlock(
      { lastUserPrompt: sample.goal, lastAssistantMessage: sample.reply },
      'Claude'
    ),
    suggestions,
    rank: true,
    risk: true
  }
  const orders: string[][] = []
  const rankedBy: string[] = []
  const risks: Record<string, number[]> = {}
  const scores: Record<string, number[]> = {}
  const done: boolean[] = []
  const readings: Record<'resolved' | 'remaining' | 'room' | 'verified', number[]> = {
    resolved: [],
    remaining: [],
    room: [],
    verified: []
  }
  const unsureBy = { resolved: 0, remaining: 0, room: 0, verified: 0 }
  let rankReadings = 0
  let rankUnsure = 0
  let donenessUnsure = 0
  let failures = 0
  const started = Date.now()
  for (let replay = 0; replay < replays; replay++) {
    const rank = await jevDecide(buildNextStepJudgeRequest(judge))
    if ('failed' in rank) {
      failures++
    } else {
      for (const answer of Object.values(rank.answers)) {
        if (answer.type === 'noul') {
          rankReadings++
          rankUnsure += nextStepDonenessIsUnsure(answer.noul) ? 1 : 0
        }
      }
      const judged = applyNextStepJudgement(judge, rank)
      orders.push(judged.suggestions.map((step) => step.id))
      rankedBy.push(judged.rankedBy ?? 'none')
      for (const step of judged.suggestions) {
        ;(risks[step.title] ??= []).push(step.jevRisk ?? Number.NaN)
        ;(scores[step.title] ??= []).push(judged.jevScores?.[step.id] ?? Number.NaN)
      }
    }
    const doneness = await jevDecide(
      buildNextStepDonenessRequest({
        conversation: { worktreeId: 'probe', paneKey: 'probe', kind: 'pty' },
        turnKey: `${sample.id}@${replay}`,
        goal: sample.goal,
        replyTail: sample.reply
      })
    )
    const reading = 'failed' in doneness ? null : readNextStepDoneness(doneness, sample.id, 0)
    if (!reading) {
      failures++
      continue
    }
    readings.resolved.push(reading.resolved)
    readings.remaining.push(reading.remainingWork)
    readings.room.push(reading.roomToImprove)
    readings.verified.push(reading.verified)
    donenessUnsure += reading.unsure ? 1 : 0
    unsureBy.resolved += nextStepDonenessIsUnsure(reading.resolved) ? 1 : 0
    unsureBy.remaining += nextStepDonenessIsUnsure(reading.remainingWork) ? 1 : 0
    unsureBy.room += nextStepDonenessIsUnsure(reading.roomToImprove) ? 1 : 0
    unsureBy.verified += nextStepDonenessIsUnsure(reading.verified) ? 1 : 0
    done.push(nextStepLooksDone(reading))
  }
  const order = orders.length ? mode(orders) : null
  const looksDone = done.length ? mode(done) : null
  return {
    id: sample.id,
    expected: sample.expect,
    failures,
    msPerCall: Math.round((Date.now() - started) / (replays * 2)),
    rank: {
      modalOrder: order?.value.map((id) => suggestions.find((s) => s.id === id)!.title),
      orderAgreement: order?.share,
      rankedBy: mode(rankedBy),
      unsureReadings: `${rankUnsure}/${rankReadings}`,
      scores: Object.fromEntries(Object.entries(scores).map(([title, v]) => [title, stats(v)]))
    },
    risk: Object.fromEntries(
      Object.entries(risks).map(([title, v]) => [
        title,
        {
          ...stats(v),
          keyword: suggestions.find((s) => s.title === title)!.risk,
          personSaysRisky: sample.risky?.includes(title) ?? false,
          raised: v.filter((p) => p >= 0.8).length
        }
      ])
    ),
    doneness: {
      resolved: stats(readings.resolved),
      remainingWork: stats(readings.remaining),
      roomToImprove: stats(readings.room),
      verified: stats(readings.verified),
      unsureReplays: `${donenessUnsure}/${readings.resolved.length}`,
      unsureByReading: unsureBy,
      looksDone: looksDone ? { value: looksDone.value, agreement: looksDone.share } : null
    }
  }
}

async function probePair(pair: (typeof IMPROVEMENT_PAIRS)[number], replays: number) {
  const values: number[] = []
  const verdicts: string[] = []
  let unsure = 0
  let failures = 0
  for (let replay = 0; replay < replays; replay++) {
    const verdict = await judgeNextStepImprovement({ ...pair, pushPrompt: PUSH_PROMPT })
    if (!verdict) {
      failures++
      continue
    }
    values.push(verdict.improved)
    unsure += verdict.unsure ? 1 : 0
    verdicts.push(verdict.unsure ? 'unsure' : verdict.improved >= 0.8 ? 'better' : 'not-better')
  }
  const modal = verdicts.length ? mode(verdicts) : null
  return {
    id: pair.id,
    expected: pair.expect,
    failures,
    improved: values.length ? stats(values) : null,
    unsure: `${unsure}/${values.length}`,
    verdict: modal ? { value: modal.value, agreement: modal.share } : null
  }
}

async function main(): Promise<void> {
  const replays = Math.max(1, Math.min(50, Number(process.argv[2] ?? 10) || 10))
  if (!(await resolveTypesafeCredential())) {
    console.error('key unavailable: no TYPESAFE_API_KEY in the environment or connections.env')
    process.exit(2)
  }
  const results = []
  for (const sample of SAMPLES) {
    results.push(await probeSample(sample, replays))
    console.error(`[probe] ${sample.id} done`)
  }
  const improvement = []
  for (const pair of IMPROVEMENT_PAIRS) {
    improvement.push(await probePair(pair, replays))
    console.error(`[probe] ${pair.id} done`)
  }
  const report = { at: new Date().toISOString(), replays, results, improvement }
  const out = process.argv[3]
  if (out) {
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  }
  console.log(JSON.stringify(report, null, 2))
}

void main()
