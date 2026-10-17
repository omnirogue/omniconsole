import {
  readMergeWhenReadyBox,
  setMergeWhenReadyBox,
  titleWithoutMergeHold,
  type MergeHold,
  type MergeWhenReadyBoxState
} from '../../../../../shared/github/merge-when-ready-box'
import {
  mergeWhenReadyStatus,
  type AttributedMergeHold,
  type MergeWhenReadyPullRequestFacts
} from '../../../../../shared/github/merge-when-ready-facts'

/** GitHub reads and writes for one repo; injected so the flows below test without GitHub. */
export type MergeWhenReadyClient = {
  readFacts: (
    numbers: number[]
  ) => Promise<{ pullRequests: MergeWhenReadyPullRequestFacts[]; missing: number[] }>
  updatePullRequest: (number: number, updates: { title?: string; body: string }) => Promise<void>
  removeLabels: (number: number, labels: string[]) => Promise<void>
}

// Matches the main-process cap on one facts query.
export const MERGE_WHEN_READY_READ_BATCH = 50

export type MergeWhenReadyFactsRead = {
  byNumber: Map<number, MergeWhenReadyPullRequestFacts>
  missing: number[]
}

export async function readMergeWhenReadyFacts(
  client: MergeWhenReadyClient,
  numbers: readonly number[]
): Promise<MergeWhenReadyFactsRead> {
  const unique = [...new Set(numbers)]
  const byNumber = new Map<number, MergeWhenReadyPullRequestFacts>()
  const missing: number[] = []
  for (let start = 0; start < unique.length; start += MERGE_WHEN_READY_READ_BATCH) {
    const result = await client.readFacts(unique.slice(start, start + MERGE_WHEN_READY_READ_BATCH))
    for (const pr of result.pullRequests) {
      byNumber.set(pr.number, pr)
    }
    missing.push(...result.missing)
  }
  return { byNumber, missing }
}

async function readOne(
  client: MergeWhenReadyClient,
  number: number
): Promise<MergeWhenReadyPullRequestFacts | null> {
  return (await readMergeWhenReadyFacts(client, [number])).byNumber.get(number) ?? null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Writes the PR and, when the write throws, reads it back: a write that timed out can still
 * have landed, and GitHub's state is what the job acts on.
 */
async function updateOrConfirm(
  client: MergeWhenReadyClient,
  number: number,
  updates: { title?: string; body: string },
  expected: MergeWhenReadyBoxState
): Promise<void> {
  try {
    await client.updatePullRequest(number, updates)
  } catch (error) {
    const after = await readOne(client, number).catch(() => null)
    if (readMergeWhenReadyBox(after?.body) !== expected) {
      throw error
    }
  }
}

function sameHold(a: MergeHold, b: MergeHold): boolean {
  return a.kind === 'label'
    ? b.kind === 'label' && a.label === b.label
    : b.kind === 'title' && a.phrase === b.phrase
}

export type MergeWhenReadyArmWarning =
  | { kind: 'labels-kept'; labels: string[]; message: string }
  | { kind: 'title-kept'; phrase: string }

export type MergeWhenReadyArmOutcome =
  | { kind: 'armed'; warnings: MergeWhenReadyArmWarning[] }
  | { kind: 'held'; holds: AttributedMergeHold[] }
  | { kind: 'already-armed' }
  | { kind: 'no-box' }
  | { kind: 'not-open' }
  | { kind: 'missing' }
  | { kind: 'unverified' }

/**
 * Ticks one PR's box after a fresh read. A held PR comes back as 'held' unless the person
 * agreed to lift every hold it has now (`liftHolds` is the list they were shown); then the
 * title marker goes in the same edit as the tick and the hold labels come off after it.
 */
export async function armMergeWhenReady(
  client: MergeWhenReadyClient,
  number: number,
  options: { liftHolds: readonly MergeHold[] }
): Promise<MergeWhenReadyArmOutcome> {
  const facts = await readOne(client, number)
  if (!facts) {
    return { kind: 'missing' }
  }
  const status = mergeWhenReadyStatus(facts)
  if (status.kind === 'not-open' || status.kind === 'no-box') {
    return { kind: status.kind }
  }
  if (status.kind === 'armed') {
    return { kind: 'already-armed' }
  }
  // Why: a hold set after the person saw the list was never agreed to, so it still wins.
  if (
    status.kind === 'held' &&
    !status.holds.every((hold) => options.liftHolds.some((lifted) => sameHold(hold, lifted)))
  ) {
    return { kind: 'held', holds: status.holds }
  }
  const body = setMergeWhenReadyBox(facts.body, true)
  if (body === null) {
    return { kind: 'no-box' }
  }
  const holds = status.kind === 'held' ? status.holds : []
  const warnings: MergeWhenReadyArmWarning[] = []
  const updates: { title?: string; body: string } = { body }
  const titleHold = holds.find((hold) => hold.kind === 'title')
  if (titleHold?.kind === 'title') {
    const title = titleWithoutMergeHold(facts.title)
    if (title) {
      updates.title = title
    } else {
      warnings.push({ kind: 'title-kept', phrase: titleHold.phrase })
    }
  }
  await updateOrConfirm(client, number, updates, 'ticked')
  const labels = holds.flatMap((hold) => (hold.kind === 'label' ? [hold.label] : []))
  if (labels.length > 0) {
    try {
      await client.removeLabels(number, labels)
    } catch (error) {
      // Why: the tick already landed and the job drops do-not-merge itself, so a failed
      // label removal is reported, not treated as a failed arm.
      warnings.push({ kind: 'labels-kept', labels, message: errorMessage(error) })
    }
  }
  const after = await readOne(client, number)
  return after && readMergeWhenReadyBox(after.body) === 'ticked'
    ? { kind: 'armed', warnings }
    : { kind: 'unverified' }
}

export type MergeWhenReadyDisarmOutcome =
  | { kind: 'disarmed' }
  | { kind: 'already-disarmed' }
  | { kind: 'no-box' }
  | { kind: 'not-open' }
  | { kind: 'missing' }
  | { kind: 'unverified' }

/** Unticks one PR's box after a fresh read, so the job leaves it alone. */
export async function disarmMergeWhenReady(
  client: MergeWhenReadyClient,
  number: number
): Promise<MergeWhenReadyDisarmOutcome> {
  const facts = await readOne(client, number)
  if (!facts) {
    return { kind: 'missing' }
  }
  if (facts.state !== 'open') {
    return { kind: 'not-open' }
  }
  const box = readMergeWhenReadyBox(facts.body)
  const body = setMergeWhenReadyBox(facts.body, false)
  if (box === 'absent' || body === null) {
    return { kind: 'no-box' }
  }
  if (box === 'unticked') {
    return { kind: 'already-disarmed' }
  }
  await updateOrConfirm(client, number, { body }, 'unticked')
  const after = await readOne(client, number)
  if (after && after.state !== 'open') {
    return { kind: 'not-open' }
  }
  return after && readMergeWhenReadyBox(after.body) === 'unticked'
    ? { kind: 'disarmed' }
    : { kind: 'unverified' }
}

export type MergeAllSkipReason =
  | { kind: 'held'; holds: AttributedMergeHold[] }
  | { kind: 'armed' }
  | { kind: 'no-box' }
  | { kind: 'not-open' }
  | { kind: 'missing' }

export type MergeAllPlan = {
  arm: MergeWhenReadyPullRequestFacts[]
  skip: { number: number; title: string; reason: MergeAllSkipReason }[]
}

/** Which listed PRs "Merge all" ticks; a held PR is always skipped, never lifted. */
export function planMergeAll(
  numbers: readonly number[],
  read: MergeWhenReadyFactsRead
): MergeAllPlan {
  const plan: MergeAllPlan = { arm: [], skip: [] }
  for (const number of new Set(numbers)) {
    const facts = read.byNumber.get(number)
    if (!facts) {
      plan.skip.push({ number, title: '', reason: { kind: 'missing' } })
      continue
    }
    const status = mergeWhenReadyStatus(facts)
    if (status.kind === 'ready') {
      plan.arm.push(facts)
    } else {
      plan.skip.push({
        number,
        title: facts.title,
        reason: status.kind === 'held' ? { kind: 'held', holds: status.holds } : status
      })
    }
  }
  return plan
}

export type MergeAllRun = {
  plan: MergeAllPlan
  armed: number[]
  failed: { number: number; title: string; message: string }[]
  unverified: number[]
}

/**
 * Re-reads the listed PRs, ticks every one that is still ready, then reads them back.
 * Why re-read: the preview can be minutes old, and a hold added since then must still win.
 */
export async function runMergeAll(
  client: MergeWhenReadyClient,
  numbers: readonly number[],
  onProgress?: (done: number, total: number) => void
): Promise<MergeAllRun> {
  const plan = planMergeAll(numbers, await readMergeWhenReadyFacts(client, numbers))
  const written: number[] = []
  const failed: MergeAllRun['failed'] = []
  for (const [index, facts] of plan.arm.entries()) {
    const body = setMergeWhenReadyBox(facts.body, true)
    if (body !== null) {
      try {
        await client.updatePullRequest(facts.number, { body })
        written.push(facts.number)
      } catch (error) {
        failed.push({ number: facts.number, title: facts.title, message: errorMessage(error) })
      }
    }
    onProgress?.(index + 1, plan.arm.length)
  }
  // Why: a write that threw can still have landed (a timeout after GitHub applied it), so
  // failed writes are read back too and count as armed when GitHub shows the tick.
  const failedNumbers = new Set(failed.map((entry) => entry.number))
  const attempted = plan.arm
    .map((facts) => facts.number)
    .filter((number) => written.includes(number) || failedNumbers.has(number))
  let ticked = new Set<number>()
  if (attempted.length > 0) {
    try {
      const after = await readMergeWhenReadyFacts(client, attempted)
      ticked = new Set(
        attempted.filter(
          (number) => readMergeWhenReadyBox(after.byNumber.get(number)?.body) === 'ticked'
        )
      )
    } catch {
      // Why: without a read-back, sent writes stay unconfirmed and thrown ones stay failed.
    }
  }
  return {
    plan,
    armed: attempted.filter((number) => ticked.has(number)),
    failed: failed.filter((entry) => !ticked.has(entry.number)),
    unverified: written.filter((number) => !ticked.has(number))
  }
}
