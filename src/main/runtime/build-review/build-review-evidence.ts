import { win32 } from 'node:path'
import {
  REVIEW_CHECK_VERSION,
  type CheckedReviewFinding,
  type ReviewEvidence,
  type ReviewFinding
} from '../../../shared/review-findings'
import type { OrcaRuntimeService } from '../omni-runtime'
import { readWorkspaceWholeFile } from '../workspace-whole-file'

// A "repro" that fails or prints whatever it is told proves nothing about the candidate.
const SELF_PROVING = /^(?:echo|printf|true|false|exit|yes|test|\[|:)$/i

type Verdict = Pick<CheckedReviewFinding, 'status' | 'detail'>
export type ReviewEvidenceHost = {
  /** The workspace on this machine, or null when it runs elsewhere and nothing can be run here. */
  workspacePath: string | null
  /** Files the builder reported, where a quote without a file is looked for. */
  files: readonly string[]
}

/** Where each run's reviewer evidence can run: its workspace on this machine, or null (remote). */
const evidenceWorkspaces = new WeakMap<object, string | null>()

export function setReviewEvidenceWorkspace(run: object, path: string | null): void {
  evidenceWorkspaces.set(run, path)
}

export function reviewEvidenceWorkspace(run: object): string | null {
  return evidenceWorkspaces.get(run) ?? null
}

/** The local path of the pipeline's workspace; null for a remote or unresolvable one. */
export async function localReviewWorkspacePath(
  runtime: Pick<OrcaRuntimeService, 'showManagedTerminalWorkspace' | 'showRepo'>,
  selector: string
): Promise<string | null> {
  try {
    const workspace = await runtime.showManagedTerminalWorkspace(selector)
    const repo = await runtime.showRepo(`id:${workspace.repoId}`)
    return repo.connectionId ? null : workspace.path
  } catch {
    return null
  }
}

async function checkQuote(
  evidence: Extract<ReviewEvidence, { kind: 'quote' }>,
  host: ReviewEvidenceHost & { workspacePath: string }
): Promise<Pick<CheckedReviewFinding, 'status' | 'detail'>> {
  const files = evidence.file ? [evidence.file] : host.files
  let unread: string | null = null
  for (const file of files) {
    const content = await readWorkspaceWholeFile(host.workspacePath, file)
    if (content === null) {
      unread ??= file
    } else if (content.includes(evidence.text)) {
      return {
        status: 'located',
        detail: `quoted text found in ${file}; that locates the problem but does not prove it`
      }
    }
  }
  if (files.length === 0 || unread !== null) {
    return {
      status: 'unverified',
      detail: unread
        ? `${unread} could not be read in full inside the workspace, so the quote's absence is not proven`
        : 'no file was named or reported to look for the quote in'
    }
  }
  // A misquoted real bug must never let a change through, so an absent quote still blocks.
  return {
    status: 'unverified',
    detail: 'The quoted text was not found in the file; the finding still blocks'
  }
}

/** A reviewer's own command never confirms or clears a blocker: located, or unverified if self-proving. */
function checkCommand(evidence: Extract<ReviewEvidence, { kind: 'command' }>): Verdict {
  if (evidence.outputInvalid) {
    return {
      status: 'unverified',
      detail:
        'the expected output given is not usable text (empty, not a string, or over 2000 characters)'
    }
  }
  const output = evidence.output
  if (
    SELF_PROVING.test(win32.basename(evidence.program).replace(/\.(?:exe|cmd|bat|ps1)$/i, '')) ||
    (output !== undefined && evidence.args.some((arg) => arg.includes(output)))
  ) {
    return {
      status: 'unverified',
      detail: 'the command could prove its own claim without exercising the candidate'
    }
  }
  return {
    status: 'located',
    detail: 'Commands and named tests are not run; the finding still blocks.'
  }
}

/** Named tests are not run yet: the finding is located and still blocks. */
function checkTest(): Verdict {
  return {
    status: 'located',
    detail: 'Commands and named tests are not run; the finding still blocks.'
  }
}

/** Check one finding's evidence against the candidate as it stands in the workspace now. */
export async function checkReviewFinding(
  finding: ReviewFinding,
  host: ReviewEvidenceHost
): Promise<CheckedReviewFinding> {
  return { ...(await checkFinding(finding, host)), checkVersion: REVIEW_CHECK_VERSION }
}

async function checkFinding(
  finding: ReviewFinding,
  host: ReviewEvidenceHost
): Promise<CheckedReviewFinding> {
  if (!finding.evidence) {
    return { ...finding, status: 'needs-evidence' }
  }
  if (!host.workspacePath) {
    return {
      ...finding,
      status: 'unverified',
      detail: 'the workspace runs on another host, where this check cannot run yet'
    }
  }
  const local = { ...host, workspacePath: host.workspacePath }
  const checked =
    finding.evidence.kind === 'quote'
      ? await checkQuote(finding.evidence, local)
      : finding.evidence.kind === 'test'
        ? checkTest()
        : checkCommand(finding.evidence)
  return { ...finding, ...checked }
}

/**
 * Every blocker's evidence, checked in order (commands one at a time: they share the workspace).
 * Only blockers are checked; lesser findings pass through as reported, never blocking.
 */
export async function checkReviewFindings(
  findings: readonly ReviewFinding[],
  host: ReviewEvidenceHost
): Promise<CheckedReviewFinding[]> {
  const checked: CheckedReviewFinding[] = []
  for (const finding of findings) {
    checked.push(
      finding.severity === 'blocker'
        ? await checkReviewFinding(finding, host)
        : {
            ...finding,
            status: finding.evidence ? 'unverified' : 'needs-evidence',
            checkVersion: REVIEW_CHECK_VERSION
          }
    )
  }
  return checked
}
