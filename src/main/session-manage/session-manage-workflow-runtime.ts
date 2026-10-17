/**
 * How session management reaches the controller that owns a workflow run, without importing the
 * controller itself: that graph reaches the RPC method table, which imports session management,
 * so a static import would close a cycle. The workflow RPC module registers the reader once.
 */

import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { SessionObserveSources } from './session-manage-observe'
import type { SessionWorkflowRunReader } from './session-manage-workflow'

type ReaderFactory = (runtime: OrcaRuntimeService) => SessionWorkflowRunReader

let readerFactory: ReaderFactory | null = null

/** Returns the restore. */
export function setSessionWorkflowRunReaderFactory(next: ReaderFactory | null): () => void {
  const previous = readerFactory
  readerFactory = next
  return () => {
    readerFactory = previous
  }
}

/**
 * The runtime's observe sources, with workflow runs read from their controller. Without a
 * registered reader a workflow row falls back to what the window last read: that can keep a run
 * (running, waiting on the person) but never makes it ordinarily removable — a finish the
 * controller did not confirm counts as unverifiable (session-manage-workflow.ts).
 */
export function withRuntimeWorkflowRuns(
  sources: SessionObserveSources,
  runtime: OrcaRuntimeService
): SessionObserveSources {
  return readerFactory ? { ...sources, workflowRun: readerFactory(runtime) } : sources
}
