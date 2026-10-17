import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import type { ArtifactLifecycleRequest } from '../../../../shared/artifact-review'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { openLinkedSession } from '@/lib/open-linked-session'
import { artifactName } from './artifact-display-labels'
import {
  ARTIFACT_BULK_MAX_IN_FLIGHT,
  artifactBulkConfirmation,
  artifactBulkOutcomeSummary,
  artifactBulkSkipSummary,
  planArtifactBulkAction,
  runArtifactLifecycleQueue,
  type ArtifactBulkAction,
  type ArtifactBulkOutcome
} from './artifact-bulk-lifecycle'
import {
  artifactCloseRequest,
  artifactReopenRequest,
  artifactSupersedeRequest,
  artifactUndoRequest,
  artifactUnsupersedeRequest,
  isArtifactLifecycleConflict
} from './artifact-lifecycle-actions'
import {
  applyArtifactReviewStatus,
  changeArtifactLifecycle,
  fetchArtifactAttention
} from './artifact-lifecycle-client'
import { undoArtifactBulk } from './artifact-bulk-undo'
import { createArtifactLifecycleGate } from './artifact-lifecycle-gate'
import type { ArtifactRowActionHandlers } from './artifact-row-actions'
import type { ArtifactSessionLink } from './use-artifact-session-links'

const BULK_TOAST_ID = 'artifacts-bulk-lifecycle'

type Replace = (
  identity: string,
  slug: string,
  update: (item: ArtifactListItem) => ArtifactListItem
) => void

export type ArtifactPickerTarget = { mode: 'row'; item: ArtifactListItem } | { mode: 'bulk' }

function rowRequest(
  item: ArtifactListItem,
  key: 'markDone' | 'noAction' | 'reopen' | 'removeSuccessor'
): ArtifactLifecycleRequest | null {
  switch (key) {
    case 'markDone':
      return artifactCloseRequest(item, 'done')
    case 'noAction':
      return artifactCloseRequest(item, 'no_action')
    case 'reopen':
      return artifactReopenRequest(item.artifact)
    case 'removeSuccessor':
      return artifactUnsupersedeRequest(item.artifact)
  }
}

export function useArtifactLifecycleActions({
  identity,
  artifacts,
  replaceArtifact,
  sessionLinks,
  checkedSlugs,
  clearChecked,
  confirm
}: {
  identity: string | null
  artifacts: readonly ArtifactListItem[]
  replaceArtifact: Replace
  sessionLinks: ReadonlyMap<string, ArtifactSessionLink>
  checkedSlugs: ReadonlySet<string>
  clearChecked: () => void
  confirm: ConfirmationDialogContextValue
}): {
  handlers: NonNullable<ArtifactRowActionHandlers['lifecycle']>
  picker: ArtifactPickerTarget | null
  closePicker: () => void
  pickSuccessor: (slug: string) => void
  runBulk: (action: ArtifactBulkAction) => void
  bulkRunning: boolean
  /** An Undo is sending; the bulk bar stays disabled until it ends. */
  undoRunning: boolean
} {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [picker, setPicker] = useState<ArtifactPickerTarget | null>(null)
  const [bulkRunning, setBulkRunning] = useState(false)
  const [undoRunning, setUndoRunning] = useState(false)
  const [gate] = useState(() => createArtifactLifecycleGate(ARTIFACT_BULK_MAX_IN_FLIGHT))
  // Why a ref: a second bulk or an undo must see the first one before React re-renders.
  const operation = useRef<'bulk' | 'undo' | null>(null)

  const markBusy = (slug: string, on: boolean): void =>
    setBusy((current) => {
      const next = new Set(current)
      if (on) {
        next.add(slug)
      } else {
        next.delete(slug)
      }
      return next
    })

  /** One call; the row is replaced with the page the server returned. */
  const send = useCallback(
    async (item: ArtifactListItem, request: ArtifactLifecycleRequest, owner: string) => {
      const result = await gate.run(() => changeArtifactLifecycle(item.artifact.slug, request))
      if (result.ok) {
        replaceArtifact(owner, item.artifact.slug, (row) =>
          applyArtifactReviewStatus(row, result.status)
        )
      }
      return result
    },
    [replaceArtifact, gate]
  )

  const runRow = async (
    item: ArtifactListItem,
    request: ArtifactLifecycleRequest | null
  ): Promise<void> => {
    if (!identity || !request) {
      return
    }
    markBusy(item.artifact.slug, true)
    try {
      const result = await send(item, request, identity)
      if (!result.ok) {
        toast.error(result.words)
      } else if (request.action === 'reopen' || request.action === 'unsupersede') {
        // Why: the status document has no per-viewer state; the close cleared needsYou locally.
        const attention = await fetchArtifactAttention(item.artifact.slug)
        if (attention) {
          replaceArtifact(identity, item.artifact.slug, (row) => ({ ...row, ...attention }))
        }
      }
    } finally {
      markBusy(item.artifact.slug, false)
    }
  }

  const undoBulk = async (
    owner: string,
    outcome: ArtifactBulkOutcome,
    before: Map<string, ArtifactListItem>
  ): Promise<void> => {
    if (operation.current) {
      return
    }
    operation.current = 'undo'
    setUndoRunning(true)
    try {
      const { message, failed } = await undoArtifactBulk({
        outcome,
        before,
        send: (item, request) => send(item, request, owner),
        markBusy,
        // Why: the server's reopen does not report per-viewer state; restore what the row showed.
        restoreAttention: (item) =>
          replaceArtifact(owner, item.artifact.slug, (row) =>
            item.needsYou === undefined ? row : { ...row, needsYou: item.needsYou }
          )
      })
      if (failed) {
        toast.error(message)
      } else {
        toast.success(message)
      }
    } finally {
      operation.current = null
      setUndoRunning(false)
    }
  }

  const executeBulk = async (action: ArtifactBulkAction, target: string | null): Promise<void> => {
    const owner = identity
    if (!owner || operation.current) {
      return
    }
    const selected = artifacts.filter((item) => checkedSlugs.has(item.artifact.slug))
    const plan = planArtifactBulkAction(action, selected, target)
    const targetTitle =
      target === null
        ? null
        : (() => {
            const found = artifacts.find((item) => item.artifact.slug === target)
            return found ? artifactName(found) : target
          })()
    if (plan.acted.length === 0) {
      toast.error(
        translate('auto.components.artifacts.bulk.nothing', 'Nothing to change: {{reasons}}.', {
          reasons: artifactBulkSkipSummary(plan.skipped)
        })
      )
      return
    }
    if (!(await confirm(artifactBulkConfirmation(plan, targetTitle))) || operation.current) {
      return
    }
    operation.current = 'bulk'
    toast.dismiss(BULK_TOAST_ID)
    setBulkRunning(true)
    const outcome: ArtifactBulkOutcome = { changed: [], conflicts: [], failures: [] }
    const before = new Map(plan.acted.map(({ item }) => [item.artifact.slug, item]))
    try {
      await runArtifactLifecycleQueue(plan.acted, async ({ item, request }) => {
        markBusy(item.artifact.slug, true)
        try {
          const result = await send(item, request, owner)
          const name = artifactName(item)
          if (result.ok) {
            outcome.changed.push({
              slug: item.artifact.slug,
              name,
              undo: artifactUndoRequest(request.action, result.status.artifact)
            })
          } else if (isArtifactLifecycleConflict(result.code)) {
            outcome.conflicts.push(name)
          } else {
            outcome.failures.push(name)
          }
        } finally {
          markBusy(item.artifact.slug, false)
        }
      })
    } finally {
      operation.current = null
      setBulkRunning(false)
    }
    clearChecked()
    const summary = artifactBulkOutcomeSummary(
      outcome,
      plan.skipped.map(({ item }) => artifactName(item))
    )
    const undoable = outcome.changed.some((change) => change.undo !== null)
    const show = outcome.changed.length > 0 ? toast.success : toast.error
    show(summary, {
      id: BULK_TOAST_ID,
      duration: undoable ? Infinity : undefined,
      ...(undoable
        ? {
            action: {
              label: translate('auto.components.artifacts.bulk.undo', 'Undo'),
              onClick: () => void undoBulk(owner, outcome, before)
            }
          }
        : {})
    })
  }

  const handlers: NonNullable<ArtifactRowActionHandlers['lifecycle']> = {
    run: (item, key) => void runRow(item, rowRequest(item, key)),
    pickSuccessor: (item) => setPicker({ mode: 'row', item }),
    openSession: (item) => {
      if (item.sessionRef) {
        openLinkedSession({
          sessionLedgerId: item.sessionRef,
          paneKey: sessionLinks.get(item.artifact.slug)?.paneKey
        })
      }
    },
    busy: (slug) => busy.has(slug)
  }

  return {
    handlers,
    picker,
    closePicker: () => setPicker(null),
    pickSuccessor: (slug) => {
      const current = picker
      setPicker(null)
      if (current?.mode === 'row') {
        void runRow(current.item, artifactSupersedeRequest(current.item, slug))
      } else if (current?.mode === 'bulk') {
        void executeBulk('supersede', slug)
      }
    },
    runBulk: (action) => {
      if (action === 'supersede') {
        setPicker({ mode: 'bulk' })
      } else {
        void executeBulk(action, null)
      }
    },
    bulkRunning,
    undoRunning
  }
}
