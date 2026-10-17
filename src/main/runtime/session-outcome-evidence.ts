import { verifySessionOutcomeSession } from './session-outcome-session-evidence'
import { verifySessionOutcomeReport } from './session-outcome-report-evidence'
import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { verifySessionOutcomeExternalCondition } from './session-outcome-external-evidence'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, relative, resolve, sep } from 'node:path'
import { readFile, realpath, stat } from 'node:fs/promises'
import { runProcess } from '../../shared/child-process/run-process'
import {
  sessionOutcomeConditionKey,
  type SessionOutcome,
  type SessionOutcomeCondition,
  type SessionOutcomeEvidence
} from '../../shared/session-outcome-types'
import {
  sessionOutcomeCandidatePaths,
  sessionOutcomeWorkspaceChanges
} from './session-outcome-candidate'
import {
  readWorkPlanArtifact,
  WORK_PLAN_ARTIFACT_SCHEMA
} from '../../shared/work-plan-artifact-schema'
import {
  SESSION_OUTCOME_OWN_REVIEW_REQUIRED,
  SESSION_OUTCOME_VERIFICATION_ERROR
} from './session-outcome-verification-hold'

export type SessionOutcomeVerification =
  | { verified: true; receipt: string; version?: string }
  | { verified: false; reason: string }

/** A path is inside `root` when leaving it needs no `..`; a symlink out is resolved first. */
async function insideDirectory(root: string, path: string): Promise<boolean> {
  const real = await realpath(path).catch(() => path)
  const base = await realpath(root).catch(() => root)
  const step = relative(base, real)
  return Boolean(step) && !step.startsWith('..') && !step.startsWith(`..${sep}`)
}

/**
 * The mockups a `work-plan-v1` document promises must exist, be HTML, and live in the document's
 * own output directory. `outputKind: 'mockup'` without one of them is a plan that claims a drawing
 * nobody can open — arch v5 §5 ("`outputKind:'mockup'` is BUILT").
 */
async function verifyDeliveredMockups(
  documentPath: string,
  mockups: { file: string; title: string }[]
): Promise<SessionOutcomeVerification | null> {
  if (!mockups.length) {
    return {
      verified: false,
      reason: 'A mockup outcome needs at least one built mockup listed in its plan document.'
    }
  }
  const outputDir = dirname(documentPath)
  for (const mockup of mockups) {
    const path = resolve(outputDir, mockup.file)
    if (!/\.html?$/i.test(mockup.file) || !(await insideDirectory(outputDir, path))) {
      return {
        verified: false,
        reason: `The mockup ${mockup.file} is not an HTML file inside the plan's output directory.`
      }
    }
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) {
      return { verified: false, reason: `The mockup ${mockup.file} was listed but never built.` }
    }
  }
  return null
}

/**
 * Everything a `file` condition proves BEYOND "these bytes are here".
 *
 * (1) a `schema` pin makes the delivered bytes parse against `work-plan-v1`, so a 0-byte or
 * hand-waved plan.json leaves the outcome unsatisfied (arch v5 F12, §5); (2) a plan or mockup
 * outcome must have left the workspace alone; (3) a mockup must actually have been built.
 * Returns the refusal, or null when the condition survived every one of them.
 */
async function verifyDeliveredDocument(
  condition: SessionOutcomeCondition,
  workspacePath: string,
  outcome?: SessionOutcome,
  chain?: SessionChain
): Promise<SessionOutcomeVerification | null> {
  const outputKind = outcome?.outputKind ?? 'work'
  for (const pin of condition.fileVersions ?? []) {
    if (pin.schema !== WORK_PLAN_ARTIFACT_SCHEMA) {
      continue
    }
    const path = resolve(workspacePath, pin.path)
    const text = await readFile(path, 'utf8').catch(() => null)
    if (text === null) {
      return { verified: false, reason: `The plan document is missing: ${pin.path}` }
    }
    if (pin.sha256 && createHash('sha256').update(text).digest('hex') !== pin.sha256) {
      return { verified: false, reason: 'The delivered file does not match the committed version.' }
    }
    const parsed = readWorkPlanArtifact(text)
    if (!parsed.ok) {
      return {
        verified: false,
        reason: `${pin.path} does not match ${WORK_PLAN_ARTIFACT_SCHEMA}: ${parsed.problem}`
      }
    }
    if (outputKind === 'mockup') {
      const built = await verifyDeliveredMockups(path, parsed.plan.mockups)
      if (built) {
        return built
      }
    }
  }
  if (outputKind === 'work') {
    return null
  }
  // Why it may throw rather than return: an unobservable workspace is not an unchanged one. The
  // reason carries the host's own words so a person sees WHICH observation failed.
  let changes: string[]
  try {
    changes = await sessionOutcomeWorkspaceChanges(
      workspacePath,
      sessionOutcomeCandidatePaths(outcome, chain)
    )
  } catch (error) {
    return {
      verified: false,
      reason: `${SESSION_OUTCOME_VERIFICATION_ERROR} ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return changes.length
    ? {
        verified: false,
        reason: `The plan step changed ${changes.length} workspace files outside its declared output: ${changes
          .slice(0, 10)
          .join(', ')}`
      }
    : null
}

/** Verification runs on the execution host against the committed immutable target. */
export async function verifySessionOutcomeCondition(
  condition: SessionOutcomeCondition,
  workspacePath: string,
  runtime?: OrcaRuntimeService,
  chain?: SessionChain,
  owningOutcomeId?: string
): Promise<SessionOutcomeVerification> {
  if (condition.kind === 'session') {
    return verifySessionOutcomeSession(condition, runtime, chain)
  }
  if (condition.kind === 'report') {
    return verifySessionOutcomeReport(condition, runtime, chain)
  }
  if (condition.kind === 'review' && !condition.recipientId) {
    return { verified: false, reason: SESSION_OUTCOME_OWN_REVIEW_REQUIRED }
  }
  if (condition.kind === 'file') {
    if (condition.version && !/^[a-f0-9]{64}$/.test(condition.version)) {
      return { verified: false, reason: 'Pin the expected file SHA-256 before verifying delivery.' }
    }
    let delivered: { path: string; hash: string }
    try {
      const path = await realpath(resolve(workspacePath, condition.target))
      const info = await stat(path)
      if (!info.isFile() || info.size > 64 * 1024 * 1024) {
        return {
          verified: false,
          reason: 'The expected file is missing or exceeds the verification size limit.'
        }
      }
      delivered = {
        path,
        hash: createHash('sha256')
          .update(await readFile(path))
          .digest('hex')
      }
    } catch {
      return {
        verified: false,
        reason: 'The execution host cannot read the expected delivered file.'
      }
    }
    if (condition.version && delivered.hash !== condition.version) {
      return { verified: false, reason: 'The delivered file does not match the committed version.' }
    }
    const outcome = chain?.outcomeSet?.outcomes.find((entry) => entry.id === owningOutcomeId)
    const document = await verifyDeliveredDocument(condition, workspacePath, outcome, chain)
    if (document) {
      return document
    }
    let verificationReceipt = ''
    if (condition.verification) {
      const checked = await verifySessionOutcomeCondition(
        { ...condition, kind: 'command' },
        workspacePath
      )
      if (!checked.verified) {
        return checked
      }
      const current = await readFile(delivered.path).catch(() => null)
      if (!current || createHash('sha256').update(current).digest('hex') !== delivered.hash) {
        return { verified: false, reason: 'The delivered file changed during verification.' }
      }
      verificationReceipt = `:${checked.receipt}`
    }
    return {
      verified: true,
      version: delivered.hash,
      receipt: `sha256:${delivered.hash}:${delivered.path}${verificationReceipt}`
    }
  }
  if ((condition.kind === 'command' || condition.kind === 'deployment') && condition.verification) {
    if (!condition.verification.expectedStdout?.trim()) {
      return {
        verified: false,
        reason: 'An action-specific expected output is required for command verification.'
      }
    }
    const expected = condition.verification.expectedStdout
    if (
      /(?:^|[/\\])(?:echo|printf|true)(?:\.exe)?$/i.test(condition.verification.program) ||
      condition.verification.args.some((arg) => arg.includes(expected)) ||
      (condition.kind === 'deployment' &&
        (!condition.version || !expected.includes(condition.version)))
    ) {
      return {
        verified: false,
        reason:
          'Use an independent verifier that reads the actual action target and confirms its requested version; echoing the expected receipt is not evidence.'
      }
    }
    const result = await runProcess({
      ...condition.verification,
      cwd: workspacePath,
      timeoutMs: 60_000,
      maxOutputBytes: 256 * 1024
    })
    if (
      result.code !== 0 ||
      result.timedOut ||
      (condition.verification.expectedStdout &&
        !result.stdout.includes(condition.verification.expectedStdout))
    ) {
      return {
        verified: false,
        reason: 'The committed verification command did not confirm the requested result.'
      }
    }
    return {
      verified: true,
      ...(condition.version ? { version: condition.version } : {}),
      receipt: `command:${createHash('sha256')
        .update(
          JSON.stringify([
            sessionOutcomeConditionKey(condition),
            result.code,
            condition.verification.expectedStdout ?? null
          ])
        )
        .digest('hex')}`
    }
  }
  return verifySessionOutcomeExternalCondition(condition, runtime, chain, owningOutcomeId)
}

/**
 * One receipt, written once. `planVersion` records WHICH plan version produced it — the other half
 * of `producedUnder` is `outcomeRevision` (amendment q). A v1 receipt stays valid for v2 at the
 * same revision, and neither reconcile nor a later record rewrites the stamp.
 */
export function sessionOutcomeVerifiedEvidence(
  outcome: SessionOutcome,
  condition: SessionOutcomeCondition,
  receipt: string,
  now = Date.now(),
  verifiedVersion?: string,
  planVersion?: number
): SessionOutcomeEvidence {
  return {
    planVersion: planVersion ?? 1,
    id: randomUUID(),
    outcomeId: outcome.id,
    outcomeRevision: outcome.revision,
    conditionId: condition.id,
    conditionKey: sessionOutcomeConditionKey(condition),
    kind: condition.kind,
    target: condition.target,
    ...((verifiedVersion ?? condition.version)
      ? { version: verifiedVersion ?? condition.version }
      : {}),
    receipt,
    verifiedAt: now,
    verifier: 'execution-host'
  }
}
