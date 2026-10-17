import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactSessionRecord } from '../../../../../shared/artifact-session'
import type { SessionLinkedDocsEntry } from '../../../../../shared/session-linked-docs'
import { useAppStore } from '@/store'
import { resolveBackofficeBaseUrl } from '../../../../../shared/backoffice-connection'
import { registerSessionDocumentRouting } from '@/lib/session-document-routing'
import { sessionDocumentLink } from './session-document-link'
import {
  selectOnScreenSessionLeafId,
  selectOnScreenSessionTabId
} from '@/lib/sidebar-session-on-screen'
import {
  type ArtifactSessionTarget,
  artifactSessionTargetKey
} from './session-artifact-association'
import { isArtifactModeActive } from './session-artifact-mode'
import { listSessionArtifactRecords, listSessionLinkedDocs } from './session-artifact-client'
import { type SessionPanelItem, sessionPanelItems } from './session-panel-items'
import { useSessionPanelViewRequest } from './session-panel-view-request'
import { useSessionWorkView } from './session-work-view-store'

/** How often to look for newly published or linked documents. Local reads; no network. */
const SESSION_ARTIFACT_RECORDS_REFRESH_MS = 15_000

/** Why primitives: a fresh object from a store selector re-renders forever. */
function useSessionArtifactTarget(): ArtifactSessionTarget | null {
  const worktreeId = useAppStore((s) => (s.activeView === 'terminal' ? s.activeWorktreeId : null))
  const tabId = useAppStore(selectOnScreenSessionTabId)
  const leafId = useAppStore(selectOnScreenSessionLeafId)
  return useMemo(
    () => (worktreeId && tabId ? { worktreeId, tabId, leafId } : null),
    [worktreeId, tabId, leafId]
  )
}

export type SessionDocumentSources = {
  records: ArtifactSessionRecord[]
  linked: SessionLinkedDocsEntry[]
}

const NO_SOURCES: SessionDocumentSources = { records: [], linked: [] }

/** This device's published pages and every conversation's linked docs, re-read while `targetKey` is set. */
export function useSessionDocumentSources(targetKey: string | null): SessionDocumentSources {
  const [sources, setSources] = useState<SessionDocumentSources>(NO_SOURCES)
  useEffect(() => {
    // Why: with no conversation on screen there is nothing to preview, so nothing to read.
    if (!targetKey) {
      return
    }
    let disposed = false
    const refresh = (): void => {
      if (document.visibilityState === 'hidden') {
        return
      }
      // Why each settles alone: keep the last answer of a source that failed, so a signed-out or
      // busy main process never flickers the tab.
      listSessionArtifactRecords().then(
        (records) => {
          if (!disposed) {
            setSources((current) => ({ ...current, records }))
          }
        },
        () => {}
      )
      listSessionLinkedDocs().then(
        (linked) => {
          if (!disposed) {
            setSources((current) => ({ ...current, linked }))
          }
        },
        () => {}
      )
    }
    refresh()
    const interval = setInterval(refresh, SESSION_ARTIFACT_RECORDS_REFRESH_MS)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      disposed = true
      clearInterval(interval)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
    // Why the target key: switching sessions re-reads at once instead of waiting for the tick.
  }, [targetKey])
  return sources
}

export type SessionArtifactsState = {
  /** The on-screen session's pages, Slite docs and opened files, newest first. */
  artifacts: SessionPanelItem[]
  /** Whether the right panel shows Session work instead of its stored tab. */
  active: boolean
  /** Identity of the on-screen session, so per-session UI state resets on switch. */
  sessionKey: string | null
  pickedKey: string | null
  pick: (key: string) => void
  selectionRevision: number
  selectArtifactMode: () => void
  leaveArtifactMode: () => void
}

export function useSessionArtifacts(): SessionArtifactsState {
  const target = useSessionArtifactTarget()
  const sessionKey = target ? artifactSessionTargetKey(target) : null
  const { records, linked } = useSessionDocumentSources(sessionKey)
  const [opened, setOpened] = useState<Record<string, SessionPanelItem[]>>({})
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [selectionRevision, setSelectionRevision] = useState(0)
  const artifacts = useMemo(() => {
    const items = sessionPanelItems(records, linked, target)
    for (const item of sessionKey ? (opened[sessionKey] ?? []) : []) {
      if (!items.some((existing) => existing.key === item.key)) {
        items.push(item)
      }
    }
    return items
  }, [records, linked, target, sessionKey, opened])
  const hasSession = target !== null
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const preferred = useSessionWorkView((s) => s.preferred)
  const setPreferred = useSessionWorkView((s) => s.setPreferred)
  const setAvailable = useSessionWorkView((s) => s.setAvailable)
  const pages = artifacts.filter((item) => item.kind === 'artifact').length
  const plans = artifacts.filter((item) => item.kind === 'slite').length
  useEffect(() => setAvailable(pages, plans), [pages, plans, setAvailable])

  // Only a person's click reaches this: a tab, "Open in panel", or the collapsed indicator.
  const selectArtifactMode = useCallback(() => {
    setPreferred(true)
    setRightSidebarOpen(true)
  }, [setPreferred, setRightSidebarOpen])
  const pick = useCallback(
    (key: string) => {
      if (sessionKey) {
        setPicked((current) => ({ ...current, [sessionKey]: key }))
      }
      setSelectionRevision((current) => current + 1)
    },
    [sessionKey]
  )
  const remember = useCallback(
    (item: SessionPanelItem) => {
      if (!sessionKey) {
        return
      }
      setOpened((current) => ({
        ...current,
        [sessionKey]: [
          item,
          ...(current[sessionKey] ?? []).filter((entry) => entry.key !== item.key)
        ].slice(0, 50)
      }))
    },
    [sessionKey]
  )
  // Why: a link never expands the panel (Sal, 2026-09-24). It joins the session's work either way,
  // and shows in place only when the person already has the panel open.
  const showInOpenPanel = useCallback(
    (item: SessionPanelItem): boolean => {
      remember(item)
      if (!useAppStore.getState().rightSidebarOpen) {
        return false
      }
      pick(item.key)
      setPreferred(true)
      return true
    },
    [pick, remember, setPreferred]
  )
  const targetIsCurrent = useCallback(() => {
    const state = useAppStore.getState()
    return (
      target !== null &&
      state.activeView === 'terminal' &&
      state.activeWorktreeId === target.worktreeId &&
      selectOnScreenSessionTabId(state) === target.tabId &&
      selectOnScreenSessionLeafId(state) === target.leafId
    )
  }, [target])
  useEffect(
    () =>
      registerSessionDocumentRouting(
        (url, worktreeId) => {
          if (
            !targetIsCurrent() ||
            !target ||
            !sessionKey ||
            (worktreeId && worktreeId !== target.worktreeId)
          ) {
            return false
          }
          const connection = resolveBackofficeBaseUrl(useAppStore.getState().settings ?? {})
          if (!connection.configured) {
            return false
          }
          const item = sessionDocumentLink(url, connection.baseUrl)
          return item ? showInOpenPanel(item) : false
        },
        (path, context) => {
          if (
            !targetIsCurrent() ||
            !target ||
            !sessionKey ||
            context.worktreeId !== target.worktreeId
          ) {
            return false
          }
          return showInOpenPanel({
            kind: 'file',
            key: `file:${path}`,
            at: Date.now(),
            path,
            context
          })
        }
      ),
    [target, targetIsCurrent, sessionKey, showInOpenPanel]
  )
  // A developer tab the person picked (or a shortcut asked for) wins until they pick Session work.
  const leaveArtifactMode = useCallback(() => setPreferred(false), [setPreferred])

  // A click elsewhere ("Open in panel", the collapsed indicator) asked for Session work.
  const viewRequest = useSessionPanelViewRequest((s) => s.revision)
  const lastViewRequestRef = useRef(viewRequest)
  useEffect(() => {
    if (viewRequest !== lastViewRequestRef.current) {
      lastViewRequestRef.current = viewRequest
      selectArtifactMode()
    }
  }, [selectArtifactMode, viewRequest])

  const routeRequestId = useAppStore((s) => s.rightSidebarRouteRequestId)
  const lastRouteRequestIdRef = useRef(routeRequestId)
  useEffect(() => {
    if (routeRequestId === lastRouteRequestIdRef.current) {
      return
    }
    lastRouteRequestIdRef.current = routeRequestId
    // Why: a shortcut or "reveal in Explorer" asked for a specific tab; it wins over Session work
    // the same way a click on that tab does.
    leaveArtifactMode()
  }, [leaveArtifactMode, routeRequestId])

  return {
    artifacts,
    active: isArtifactModeActive(preferred, hasSession),
    sessionKey,
    pickedKey: sessionKey ? (picked[sessionKey] ?? null) : null,
    pick,
    selectionRevision,
    selectArtifactMode,
    leaveArtifactMode
  }
}
