import React, { useRef, useState } from 'react'
import { GitMerge, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { findMergeWhenReadyBlockers } from '../../../../../shared/github/merge-when-ready-facts'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import {
  planMergeAll,
  readMergeWhenReadyFacts,
  runMergeAll,
  type MergeAllSkipReason
} from '../../github/merge-when-ready/merge-when-ready-actions'
import { createMergeWhenReadyClient } from '../../github/merge-when-ready/merge-when-ready-client'
import {
  describeMergeHold,
  describeMergeWhenReadyBlockers
} from '../../github/merge-when-ready/merge-when-ready-copy'
import { getTaskPageRepoSourceContext } from '../source/repo-source-context'
import {
  countMergeAllPreview,
  countMergeAllResults,
  groupMergeAllCandidates,
  type MergeAllGroup,
  type MergeAllGroupPreview,
  type MergeAllGroupResult
} from './merge-all-when-ready-groups'

type Phase =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'preview'; previews: MergeAllGroupPreview[] }
  | { kind: 'running'; previews: MergeAllGroupPreview[]; done: number; total: number }
  | { kind: 'done'; previews: MergeAllGroupPreview[]; results: MergeAllGroupResult[] }

type Row = { key: string; label: string; title: string; detail: string | null }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function skipReasonText(reason: MergeAllSkipReason): string {
  switch (reason.kind) {
    case 'held':
      return translate('mergeAll.skip.held', 'Held: {{holds}}', {
        holds: reason.holds.map(describeMergeHold).join('; ')
      })
    case 'armed':
      return translate('mergeAll.skip.armed', 'Already on')
    case 'no-box':
      return translate('mergeAll.skip.noBox', 'No Merge when ready box')
    case 'not-open':
      return translate('mergeAll.skip.notOpen', 'Closed or merged')
    case 'missing':
      return translate('mergeAll.skip.missing', 'Not found on GitHub')
  }
}

function RowList({ heading, rows }: { heading: string; rows: Row[] }): React.JSX.Element | null {
  if (rows.length === 0) {
    return null
  }
  return (
    <section className="grid gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {heading} ({rows.length})
      </h3>
      <ul className="grid gap-1">
        {rows.map((row) => (
          <li key={row.key} className="min-w-0 text-sm leading-snug">
            <div className="flex min-w-0 gap-2">
              <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                {row.label}
              </span>
              <span className="min-w-0 truncate">{row.title}</span>
            </div>
            {row.detail ? <p className="text-xs text-muted-foreground">{row.detail}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Ticks the Merge when ready box on every open PR in the visible list after showing what it
 * will do. Held PRs are skipped and never lifted; each PR is re-read just before its write.
 */
export function MergeAllWhenReadyButton({
  items,
  repoMap,
  onDone
}: {
  items: readonly GitHubWorkItem[]
  repoMap: ReadonlyMap<string, Repo>
  onDone: () => void
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'closed' })
  const openId = useRef(0)
  const candidates = groupMergeAllCandidates(items)
  const multiRepo = candidates.length > 1
  const prLabel = (group: MergeAllGroup, number: number) =>
    multiRepo ? `${group.slug.repo}#${number}` : `#${number}`
  const clientFor = (group: MergeAllGroup) => {
    const repo = repoMap.get(group.repoId)
    return createMergeWhenReadyClient({
      slug: group.slug,
      repoId: group.repoId,
      repoPath: repo?.path ?? null,
      sourceContext: getTaskPageRepoSourceContext(repo, 'github')
    })
  }

  const open = async (): Promise<void> => {
    const id = ++openId.current
    const groups = candidates
    setPhase({ kind: 'loading' })
    const previews = await Promise.all(
      groups.map(async (group): Promise<MergeAllGroupPreview> => {
        try {
          const read = await readMergeWhenReadyFacts(clientFor(group), group.numbers)
          return { group, plan: planMergeAll(group.numbers, read), error: null }
        } catch (error) {
          return { group, plan: null, error: errorMessage(error) }
        }
      })
    )
    if (openId.current === id) {
      setPhase({ kind: 'preview', previews })
    }
  }

  const confirm = async (previews: MergeAllGroupPreview[]): Promise<void> => {
    const total = countMergeAllPreview(previews).arm
    let done = 0
    setPhase({ kind: 'running', previews, done, total })
    const results: MergeAllGroupResult[] = []
    for (const preview of previews) {
      const requested = preview.plan?.arm.map((pr) => pr.number) ?? []
      if (requested.length === 0) {
        continue
      }
      const base = done
      try {
        const run = await runMergeAll(clientFor(preview.group), requested, (groupDone) =>
          setPhase({ kind: 'running', previews, done: base + groupDone, total })
        )
        results.push({ group: preview.group, requested, run, error: null })
      } catch (error) {
        results.push({ group: preview.group, requested, run: null, error: errorMessage(error) })
      }
      done = base + requested.length
    }
    setPhase({ kind: 'done', previews, results })
    const totals = countMergeAllResults(results)
    if (totals.armed + totals.unverified > 0) {
      useAppStore.getState().recordFeatureInteraction('github-tasks')
    }
    onDone()
  }

  const close = (): void => {
    openId.current += 1
    setPhase({ kind: 'closed' })
  }

  const titleOf = (previews: MergeAllGroupPreview[], group: MergeAllGroup, number: number) =>
    previews
      .find((preview) => preview.group.key === group.key)
      ?.plan?.arm.find((pr) => pr.number === number)?.title ?? ''

  const previewRows = (previews: MergeAllGroupPreview[]) => {
    const arm: Row[] = []
    const skip: Row[] = []
    const unreadable: Row[] = []
    for (const { group, plan, error } of previews) {
      if (!plan) {
        unreadable.push({
          key: group.key,
          label: `${group.slug.owner}/${group.slug.repo}`,
          title: translate('mergeAll.unreadablePrs', 'PRs in this list: {{total}}', {
            total: group.numbers.length
          }),
          detail: error
        })
        continue
      }
      for (const pr of plan.arm) {
        arm.push({
          key: `${group.key}#${pr.number}`,
          label: prLabel(group, pr.number),
          title: pr.title,
          detail: describeMergeWhenReadyBlockers(findMergeWhenReadyBlockers(pr))
        })
      }
      for (const entry of plan.skip) {
        skip.push({
          key: `${group.key}#${entry.number}`,
          label: prLabel(group, entry.number),
          title: entry.title,
          detail: skipReasonText(entry.reason)
        })
      }
    }
    return { arm, skip, unreadable }
  }

  const resultRows = (previews: MergeAllGroupPreview[], results: MergeAllGroupResult[]) => {
    const armed: Row[] = []
    const failed: Row[] = []
    const unverified: Row[] = []
    const skipped: Row[] = []
    const row = (group: MergeAllGroup, number: number, detail: string | null = null): Row => ({
      key: `${group.key}#${number}`,
      label: prLabel(group, number),
      title: titleOf(previews, group, number),
      detail
    })
    for (const { group, requested, run, error } of results) {
      if (!run) {
        failed.push(...requested.map((number) => row(group, number, error)))
        continue
      }
      armed.push(...run.armed.map((number) => row(group, number)))
      failed.push(...run.failed.map((entry) => row(group, entry.number, entry.message)))
      unverified.push(...run.unverified.map((number) => row(group, number)))
      skipped.push(
        ...run.plan.skip.map((entry) => row(group, entry.number, skipReasonText(entry.reason)))
      )
    }
    return { armed, failed, unverified, skipped }
  }

  const busy = phase.kind === 'loading' || phase.kind === 'running'
  const preview = phase.kind === 'preview' ? previewRows(phase.previews) : null
  const results = phase.kind === 'done' ? resultRows(phase.previews, phase.results) : null

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 border-border/60 bg-background text-xs text-foreground shadow-xs hover:bg-muted/60"
        disabled={candidates.length === 0}
        onClick={() => void open()}
      >
        <GitMerge className="size-3.5" />
        {translate('mergeAll.button', 'Merge all when ready')}
      </Button>
      <Dialog
        open={phase.kind !== 'closed'}
        onOpenChange={(next) => {
          if (!next && !busy) {
            close()
          }
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{translate('mergeAll.title', 'Merge all when ready')}</DialogTitle>
            <DialogDescription>
              {translate(
                'mergeAll.description',
                'Ticks the Merge when ready box on the open PRs in this list. The merge job merges and deploys each one once its checks pass. Held PRs are skipped, never lifted.'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="scrollbar-sleek grid max-h-[55vh] min-w-0 gap-4 overflow-y-auto pr-1">
            {phase.kind === 'loading' ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                {translate('mergeAll.loading', 'Checking each PR on GitHub…')}
              </p>
            ) : null}
            {preview ? (
              <>
                <RowList
                  heading={translate('mergeAll.willTurnOn', 'Will turn on')}
                  rows={preview.arm}
                />
                <RowList heading={translate('mergeAll.skipped', 'Skipped')} rows={preview.skip} />
                <RowList
                  heading={translate('mergeAll.unreadable', "Couldn't check")}
                  rows={preview.unreadable}
                />
                {preview.arm.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {translate('mergeAll.nothingToArm', 'No PR in this list needs turning on.')}
                  </p>
                ) : null}
              </>
            ) : null}
            {phase.kind === 'running' ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                {translate('mergeAll.running', 'Turning on {{done}} of {{total}}…', {
                  done: phase.done,
                  total: phase.total
                })}
              </p>
            ) : null}
            {results ? (
              <>
                <RowList heading={translate('mergeAll.armed', 'Turned on')} rows={results.armed} />
                <RowList
                  heading={translate('mergeAll.failed', "Couldn't turn on")}
                  rows={results.failed}
                />
                <RowList
                  heading={translate('mergeAll.unverified', 'Sent, not confirmed yet')}
                  rows={results.unverified}
                />
                <RowList
                  heading={translate('mergeAll.skippedOnRecheck', 'Skipped on re-check')}
                  rows={results.skipped}
                />
              </>
            ) : null}
          </div>
          <DialogFooter>
            {phase.kind === 'done' ? (
              <Button type="button" onClick={close}>
                {translate('mergeAll.close', 'Close')}
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" disabled={busy} onClick={close}>
                  {translate('mergeAll.cancel', 'Cancel')}
                </Button>
                <Button
                  type="button"
                  disabled={!preview || preview.arm.length === 0}
                  onClick={() => {
                    if (phase.kind === 'preview') {
                      void confirm(phase.previews)
                    }
                  }}
                >
                  {phase.kind === 'running' ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : null}
                  {translate('mergeAll.confirm', 'Merge {{total}} when ready', {
                    total: preview?.arm.length ?? (phase.kind === 'running' ? phase.total : 0)
                  })}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
