/** The session a worker runs in: a pane on this runtime, or a terminal on a paired runtime. */
export type WorkerLineageChild =
  | { kind: 'pane'; paneKey: string }
  | { kind: 'remote-terminal'; environmentId: string; terminal: string }

/**
 * One worker and the session that dispatched it, read from the orchestration record on the
 * runtime that owns the run (`orchestration.workerLineage`).
 */
export type WorkerLineageLink = {
  /** The exact owner dispatch, when this runtime knows it (older runtimes omit it). */
  dispatchId?: string
  /** Current live local worker incarnation; present only when the owner is verified. */
  processIncarnation?: string
  /** User-retained/taken-over resources belong in ordinary conversations. */
  retainedByUser?: boolean
  parentPaneKey: string
  child: WorkerLineageChild
  /** When the parent first dispatched to this worker (epoch ms). */
  dispatchedAt: number
}

export type WorkerLineageResult = { links: WorkerLineageLink[] }

export type WorkerLineageActionIdentity = {
  dispatchId: string
  processIncarnation: string
}
