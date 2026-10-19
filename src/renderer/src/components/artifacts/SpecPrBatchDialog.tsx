import { useEffect, useState } from 'react'
import type { ArtifactListItem, ArtifactCloudOperation } from '../../../../shared/artifacts'
import type { ArtifactReviewStatus } from '../../../../shared/artifact-review'
import type { Repo } from '../../../../shared/repo-types'
import type { SpecPrBatch, SpecPrBatchStart } from '../../../../shared/spec-pr-batch'
import {
  implementationApprovalCoversTarget,
  verifiedSpecPrCount
} from '../../../../shared/spec-pr-batch'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { artifactName } from './artifact-display-labels'
import { specPrBatchCopy } from './spec-pr-batch-copy'

const LOCAL = { kind: 'local' } as const
type Row = {
  item: ArtifactListItem
  review: ArtifactReviewStatus | null
  repoId: string
  baseRef: string
  error?: string
}

export function SpecPrBatchDialog({
  open,
  items,
  onClose
}: {
  open: boolean
  items: readonly ArtifactListItem[]
  onClose: () => void
}): React.JSX.Element {
  const copy = specPrBatchCopy()
  const [rows, setRows] = useState<Row[]>([])
  const [repos, setRepos] = useState<Repo[]>([])
  const [agent, setAgent] = useState<'codex' | 'claude'>('codex')
  const [batches, setBatches] = useState<SpecPrBatch[]>([])
  const [batch, setBatch] = useState<SpecPrBatch | null>(null)
  const [mutationId, setMutationId] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setError(null)
    void Promise.all([
      callRuntimeRpc<{ repos: Repo[] }>(LOCAL, 'repo.list', {}),
      callRuntimeRpc<{ batches: SpecPrBatch[] }>(LOCAL, 'specPrBatch.list', {}),
      Promise.all(
        items.map(async (item) => {
          try {
            const result = await callRuntimeRpc<ArtifactCloudOperation<ArtifactReviewStatus>>(
              LOCAL,
              'artifacts.reviewStatus',
              { slug: item.artifact.slug }
            )
            return {
              item,
              review: result.status === 'ok' ? result.value : null,
              repoId: '',
              baseRef: '',
              ...(result.status === 'ok' ? {} : { error: specPrBatchCopy().reviewUnavailable })
            } as Row
          } catch {
            return {
              item,
              review: null,
              repoId: '',
              baseRef: '',
              error: specPrBatchCopy().reviewUnavailable
            } as Row
          }
        })
      )
    ])
      .then(([repoList, recent, reviewed]) => {
        if (cancelled) {
          return
        }
        const local = repoList.repos.filter(
          (repo) =>
            repo.kind !== 'folder' &&
            !repo.connectionId &&
            (!repo.executionHostId || repo.executionHostId === 'local')
        )
        setRepos(local)
        setBatches(recent.batches)
        setRows(
          reviewed.map((row) => ({
            ...row,
            repoId: local[0]?.id ?? '',
            baseRef: local[0]?.worktreeBaseRef?.replace(/^origin\//, '') ?? ''
          }))
        )
      })
      .catch(() => {
        if (!cancelled) {
          setError('Could not load batch destinations or reviews.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, items])

  useEffect(() => {
    if (!open || !batch) {
      return
    }
    const timer = window.setInterval(
      () => {
        void callRuntimeRpc<{ batch: SpecPrBatch }>(LOCAL, 'specPrBatch.refresh', { id: batch.id })
          .then((result) => setBatch(result.batch))
          .catch(() => setError('Batch status is unavailable.'))
      },
      verifiedSpecPrCount(batch) === 5 ? 60_000 : 10_000
    )
    return () => window.clearInterval(timer)
  }, [open, batch])

  const setRow = (index: number, update: Partial<Row>): void =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...update } : row)))
  const rowEligible = (row: Row): boolean => {
    const repo = repos.find((candidate) => candidate.id === row.repoId)
    const review = row.review
    return Boolean(
      review?.status === 'approved' &&
      review.latest?.decision === 'approved' &&
      review.latest.revision === review.artifact.revision &&
      !review.supersededBy &&
      !review.lifecycle &&
      ['text/markdown', 'text/plain'].includes(review.artifact.sourceContentType) &&
      repo?.gitRemoteIdentity?.canonicalKey &&
      row.baseRef &&
      !row.error &&
      implementationApprovalCoversTarget(
        review.artifact.review?.question,
        repo.gitRemoteIdentity.canonicalKey,
        row.baseRef
      )
    )
  }
  const canStart = rows.length === 5 && rows.every(rowEligible)

  const start = async (): Promise<void> => {
    if (!canStart) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const targets = rows.map((row) => ({
        artifactSlug: row.item.artifact.slug,
        revision: row.review!.artifact.revision!,
        decisionId: row.review!.latest!.id,
        repoId: row.repoId,
        baseRef: row.baseRef
      })) as SpecPrBatchStart['targets']
      const result = await callRuntimeRpc<{ batch: SpecPrBatch }>(LOCAL, 'specPrBatch.start', {
        mutationId,
        agent,
        targets
      })
      setBatch(result.batch)
      setBatches((current) => [
        result.batch,
        ...current.filter((item) => item.id !== result.batch.id)
      ])
      setMutationId(crypto.randomUUID())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The batch could not start.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="scrollbar-sleek max-h-[min(90vh,52rem)] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        {batch ? (
          <section className="space-y-3" aria-label={copy.batchStatus}>
            <div className="flex items-center justify-between">
              <strong>{copy.verifiedDraftPrs(verifiedSpecPrCount(batch))}</strong>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void callRuntimeRpc<{ batch: SpecPrBatch }>(LOCAL, 'specPrBatch.refresh', {
                      id: batch.id
                    }).then((result) => setBatch(result.batch))
                  }
                >
                  {copy.refresh}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setBatch(null)}>
                  {copy.newBatch}
                </Button>
                {!batch.stopped ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void callRuntimeRpc<{ batch: SpecPrBatch }>(LOCAL, 'specPrBatch.stop', {
                        id: batch.id
                      }).then((result) => setBatch(result.batch))
                    }
                  >
                    {copy.stopFutureSteps}
                  </Button>
                ) : null}
              </div>
            </div>
            {batch.slots.map((slot) => (
              <div key={slot.index} className="rounded-md border border-border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{slot.title}</span>
                  <Badge variant="outline">{slot.phase.replaceAll('_', ' ')}</Badge>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {slot.repoRemote} · {slot.baseRef} · {slot.worktreePath ?? copy.workspacePending}
                </p>
                {slot.reason ? (
                  <p className="mt-1 text-xs text-muted-foreground">{slot.reason}</p>
                ) : null}
                {slot.worktreeId ? (
                  <Button
                    size="xs"
                    variant="link"
                    onClick={() =>
                      void callRuntimeRpc(LOCAL, 'worktree.activate', {
                        worktree: `id:${slot.worktreeId}`
                      })
                    }
                  >
                    {copy.openWorkspace}
                  </Button>
                ) : null}
                {slot.terminalHandle ? (
                  <Button
                    size="xs"
                    variant="link"
                    onClick={() =>
                      void callRuntimeRpc(LOCAL, 'terminal.focus', {
                        terminal: slot.terminalHandle
                      })
                    }
                  >
                    {copy.openBuilder}
                  </Button>
                ) : null}
                {slot.prUrl ? (
                  <Button
                    size="xs"
                    variant="link"
                    onClick={() => void window.api.shell.openUrl(slot.prUrl!)}
                  >
                    {copy.openDraftPr(slot.prNumber ?? '')}
                  </Button>
                ) : null}
              </div>
            ))}
          </section>
        ) : (
          <>
            {items.length === 5 ? (
              <section className="space-y-3" aria-label={copy.batchManifest}>
                {rows.map((row, index) => (
                  <div key={row.item.artifact.slug} className="rounded-md border border-border p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {index + 1}. {artifactName(row.item)}
                      </span>
                      <Badge variant="outline">
                        {copy.revision(row.review?.artifact.revision ?? '?')}
                      </Badge>
                    </div>
                    <p className="mb-2 text-xs text-muted-foreground">
                      {rowEligible(row)
                        ? copy.approvedForTarget
                        : (row.error ?? copy.needsApproval)}{' '}
                      · {row.item.artifact.slug}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Select
                        value={row.repoId}
                        onValueChange={(repoId) => {
                          const repo = repos.find((candidate) => candidate.id === repoId)
                          setRow(index, {
                            repoId,
                            baseRef: repo?.worktreeBaseRef?.replace(/^origin\//, '') ?? ''
                          })
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={copy.targetRepository} />
                        </SelectTrigger>
                        <SelectContent>
                          {repos.map((repo) => (
                            <SelectItem key={repo.id} value={repo.id}>
                              {repo.displayName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        aria-label={copy.baseBranchFor(artifactName(row.item))}
                        value={row.baseRef}
                        onChange={(event) => setRow(index, { baseRef: event.target.value })}
                        placeholder={copy.baseBranch}
                      />
                    </div>
                  </div>
                ))}
                <div className="flex items-center justify-between gap-2">
                  <Select
                    value={agent}
                    onValueChange={(value) => setAgent(value as 'codex' | 'claude')}
                  >
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="codex">{copy.agentCodex}</SelectItem>
                      <SelectItem value="claude">{copy.agentClaude}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button disabled={!canStart || busy} onClick={() => void start()}>
                    {copy.build}
                  </Button>
                </div>
              </section>
            ) : (
              <p className="text-sm text-muted-foreground">{copy.selectFive}</p>
            )}
            {batches.length ? (
              <section className="space-y-1 border-t border-border pt-3">
                <h3 className="text-xs font-semibold text-muted-foreground">
                  {copy.recentBatches}
                </h3>
                {batches.slice(0, 8).map((item) => (
                  <Button
                    key={item.id}
                    size="sm"
                    variant="ghost"
                    className="w-full justify-between"
                    onClick={() => {
                      setBatch(item)
                      void callRuntimeRpc<{ batch: SpecPrBatch }>(LOCAL, 'specPrBatch.refresh', {
                        id: item.id
                      })
                        .then((result) => setBatch(result.batch))
                        .catch(() => setError('Batch status is unavailable.'))
                    }}
                  >
                    <span>{new Date(item.createdAt).toLocaleString()}</span>
                    <span>{copy.draftPrs(verifiedSpecPrCount(item))}</span>
                  </Button>
                ))}
              </section>
            ) : null}
          </>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
