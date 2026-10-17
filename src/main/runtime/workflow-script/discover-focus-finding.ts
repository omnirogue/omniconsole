import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type Database from '../../sqlite/sync-database'
import { discoverOmniosRun, type DiscoverOmniosFinding } from '../../../shared/discover-omnios-page'
import { workflowRunResult } from '../../../shared/workflow-run-result'
import type { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { projectLocalWorkflow, readLocalWorkflowExecution } from './local-workflow-projection'
import { EARLIER_TITLE_MAX_CHARS, type WorkflowEarlierFindings } from './workflow-earlier-findings'

/** Page numbers refer to the ranked page, never the raw finder order. */
export function readDiscoverFocusFinding(
  db: Database.Database,
  store: WorkflowCheckpointStore,
  reference: string,
  workspaceId: string,
  pageRoot?: string
): DiscoverOmniosFinding {
  const match = /^([a-zA-Z0-9_-]{1,128}):([1-9][0-9]{0,3})$/.exec(reference)
  if (!match) {
    throw new Error('--focus-finding must be <run>:<finding number>.')
  }
  const [, executionId, number] = match
  const row = readLocalWorkflowExecution(db, executionId)
  const snapshot = store.inspect(executionId, row.fence).snapshot as LocalWorkflowHostSnapshot
  const template = snapshot.graph?.spec.template
  if (
    row.state !== 'completed' ||
    !['discover', 'quick-discover'].includes(template ?? '') ||
    snapshot.host.workspaceId !== workspaceId
  ) {
    throw new Error('--focus-finding needs a completed Discover run in this workspace.')
  }
  // Published page numbers survive later changes to the ranking algorithm.
  if (pageRoot) {
    const file = join(pageRoot, executionId, 'findings.json')
    let page: { findings?: DiscoverOmniosFinding[] } | undefined
    try {
      if (statSync(file).size > 2 * 1024 * 1024) {
        throw new Error('page exceeds its size limit')
      }
      page = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('--focus-finding: cannot read the saved page; no run started.')
      }
    }
    if (page !== undefined) {
      const finding = Array.isArray(page?.findings)
        ? page.findings.find((finding) => finding?.n === Number(number))
        : undefined
      if (
        !finding ||
        !['key', 'title', 'location', 'detail', 'why', 'next'].every(
          (key) => typeof finding[key as keyof DiscoverOmniosFinding] === 'string'
        )
      ) {
        throw new Error(`--focus-finding: no valid finding ${number} on the saved page.`)
      }
      return finding
    }
  }
  const view = projectLocalWorkflow({ db, store, executionId, active: false })
  const result = workflowRunResult(
    view,
    {
      executionId,
      worktreeId: workspaceId,
      conversationId: snapshot.host.conversationId
    },
    template!,
    0
  )
  const run = discoverOmniosRun(result, { goal: snapshot.task.prompt, workspace: workspaceId })
  const finding = run.findings.find((finding) => finding.n === Number(number))
  if (!finding) {
    throw new Error(`--focus-finding: no finding ${number} on that run's page.`)
  }
  return finding
}

export function discoverFocusedPrompt(prompt: string, finding: DiscoverOmniosFinding): string {
  return `${prompt}\n\nDig deeper into this finding; check and extend its evidence:\n${finding.title}\n${finding.location}\n${finding.detail}\nWhy: ${finding.why}\nNext: ${finding.next}`
}

/** Keep every other earlier title, including other findings from the parent run. */
export function withoutDiscoverFocus(
  earlier: WorkflowEarlierFindings,
  finding: DiscoverOmniosFinding | undefined
): WorkflowEarlierFindings {
  if (!finding) {
    return earlier
  }
  const title = finding.title
  const display = finding.location ? `${title} (${finding.location})` : title
  const truncated = `${display.slice(0, EARLIER_TITLE_MAX_CHARS - 1)}…`
  return {
    ...earlier,
    titles: earlier.titles.filter(
      (line) =>
        line !== title &&
        !line.startsWith(`${title} (`) &&
        !(display.length > EARLIER_TITLE_MAX_CHARS && line === truncated)
    )
  }
}
