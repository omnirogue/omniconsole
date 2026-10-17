import { useSessionFolders } from '@/store/session-folders'
import type { SessionFinishChoice } from '../../../../shared/session-finish-intent'
import { UpNextVisibilityContext } from './up-next-visibility'
import type { ConversationSource } from '../../../../shared/conversation-source'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionOutcomeRuntimeTarget } from '../../../../shared/session-outcome-routing'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { upNextConnection } from './up-next-connection'
import { commitUpNext, type UpNextSurface } from './up-next-commit'
import { upNextRefusal } from './up-next-refusal'
import {
  UP_NEXT_RPC,
  UP_NEXT_REFUSAL_KEYS,
  isUpNextConversation,
  type UpNextConversationId,
  type UpNextAppendPosition,
  type UpNextBlockPatch,
  type UpNextDraftInput,
  type UpNextView
} from '../../../../shared/up-next-types'
import { readUpNext, writeUpNext } from './up-next-client'

export type UpNextController = {
  whenFinished?: SessionFinishChoice
  setWhenFinished?: (choice: SessionFinishChoice | null) => Promise<boolean>
  view: UpNextView | null
  error: string | null
  disabled: boolean
  append: (
    draft: UpNextDraftInput,
    options?: { position?: UpNextAppendPosition; insertAfterBlockId?: string }
  ) => Promise<boolean>
  update: (blockId: string, patch: UpNextBlockPatch) => Promise<boolean>
  reorder: (blockId: string, direction: -1 | 1) => Promise<boolean>
  remove: (blockId: string) => Promise<boolean>
  commit: () => Promise<boolean>
  discardDrafts: () => Promise<boolean>
  configureAfter: (blockId: string) => Promise<boolean>
  /** "Queue again" on a failed queued prompt; offered only where the host marked it. */
  requeue?: (blockId: string) => Promise<boolean>
}

export function useUpNext(
  source: UpNextConversationId | null,
  onError?: (message: string) => void,
  surface: UpNextSurface = {},
  owner: SessionOutcomeRuntimeTarget = { kind: 'local' }
): UpNextController {
  useSessionFolders((state) => state.metadata)
  const visible = useContext(UpNextVisibilityContext)
  const visibleRef = useRef(visible)
  useEffect(() => {
    visibleRef.current = visible
  }, [visible])
  const ownerKey = JSON.stringify(owner)
  const revision =
    owner.kind === 'environment' ? getRuntimeEnvironmentRevision(owner.environmentId) : undefined
  const connection = useMemo(
    () => upNextConnection(JSON.parse(ownerKey) as SessionOutcomeRuntimeTarget, revision),
    [ownerKey, revision]
  )
  const sourceKey = source ? JSON.stringify(source) : null
  const key = sourceKey ? JSON.stringify([sourceKey, ownerKey, revision]) : null
  const addressed = useRef<UpNextConversationId | null>(source)
  const started = useRef<ConversationSource | null>(null)
  const [snapshot, setSnapshot] = useState<{
    key: string
    view: UpNextView
  } | null>(null)
  const [failure, setFailure] = useState<{
    key: string
    message: string
  } | null>(null)
  const [pending, setPending] = useState(false)
  const generation = useRef(0)
  const busy = useRef(false)
  const mutationVersion = useRef(0)
  useEffect(() => {
    const epoch = ++generation.current
    addressed.current = sourceKey ? (JSON.parse(sourceKey) as UpNextConversationId) : null
    started.current = null
    busy.current = false
    setPending(false)
    setFailure(null)
    if (!key) {
      return
    }
    let reading = false
    const read = async () => {
      if (!visibleRef.current || reading || busy.current) {
        return
      }
      reading = true
      const version = mutationVersion.current
      try {
        const view = await readUpNext(addressed.current!, connection)
        if (generation.current === epoch && !busy.current && mutationVersion.current === version) {
          setSnapshot({ key, view })
        }
      } catch (error) {
        if (generation.current === epoch) {
          setFailure({
            key,
            message: error instanceof Error ? error.message : String(error)
          })
        }
      } finally {
        reading = false
      }
    }
    void read()
    const timer = setInterval(() => void read(), 2000)
    return () => {
      generation.current = epoch + 1
      clearInterval(timer)
    }
  }, [key, sourceKey, connection])
  const mutate = useCallback(
    async (method: string, params: Record<string, unknown>) => {
      if (!key || busy.current) {
        return false
      }
      const epoch = generation.current
      busy.current = true
      mutationVersion.current++
      setPending(true)
      try {
        const onRead = (view: UpNextView) => {
          if (generation.current === epoch) {
            if (isUpNextConversation(view.conversationId)) {
              addressed.current = view.conversationId
            }
            setSnapshot({ key, view })
          }
        }
        if (
          method === 'whenFinished' ||
          method === UP_NEXT_RPC.append ||
          method === UP_NEXT_RPC.commit
        ) {
          const legacy =
            snapshot?.key === key
              ? snapshot.view.blocks.find((block) => block.kind === 'done' && !block.locked)
              : undefined
          if (method === 'whenFinished' || (legacy && surface.scheduleFinish)) {
            const source = addressed.current
            if (!source || !isUpNextConversation(source) || !surface.scheduleFinish) {
              throw new Error(UP_NEXT_REFUSAL_KEYS.subjectNotStarted)
            }
            const current = await readUpNext(source, connection)
            if (current.finishReady === undefined) {
              throw new Error(
                'Update this execution host to choose what happens when the session finishes.'
              )
            }
            const old = current.blocks.find((block) => block.kind === 'done' && !block.locked)
            if (old) {
              await writeUpNext(source, UP_NEXT_RPC.remove, { blockId: old.id }, onRead, connection)
            }
            connection.assertCurrent()
            surface.scheduleFinish(
              method === 'whenFinished'
                ? (params.choice as SessionFinishChoice | null)
                : old?.kind === 'done'
                  ? {
                      action: old.finish === 'save' ? 'save' : 'end',
                      ...(old.folderId ? { folderId: old.folderId } : {})
                    }
                  : null,
              source
            )
          }
        }
        if (method === 'whenFinished') {
          // The preference is saved independently; queue drafts remain untouched.
        } else if (method === UP_NEXT_RPC.commit) {
          const view = await readUpNext(addressed.current!, connection)
          if (generation.current !== epoch) {
            return false
          }
          await commitUpNext(
            view,
            {
              ...surface,
              start: async () => {
                if (started.current) {
                  return started.current
                }
                if (!surface.start) {
                  throw new Error(UP_NEXT_REFUSAL_KEYS.subjectNotStarted)
                }
                return surface.start()
              }
            },
            onRead,
            (source) => {
              if (generation.current === epoch) {
                started.current = source
              }
            },
            connection
          )
        } else {
          await writeUpNext(addressed.current!, method, params, onRead, connection)
        }
        if (generation.current === epoch) {
          setFailure(null)
        }
        return true
      } catch (error) {
        const message = upNextRefusal(error)
        if (generation.current === epoch) {
          onError?.(message)
          setFailure({
            key,
            message
          })
        }
        return false
      } finally {
        if (generation.current === epoch) {
          busy.current = false
          setPending(false)
        }
      }
    },
    [key, onError, surface, connection, snapshot]
  )
  const shown = snapshot?.key === key ? snapshot.view : null
  const choice =
    shown && isUpNextConversation(shown.conversationId)
      ? surface.readFinish?.(shown.conversationId)
      : undefined
  return {
    whenFinished: choice,
    setWhenFinished: (choice) => mutate('whenFinished', { choice }),
    view: snapshot?.key === key ? snapshot.view : null,
    error: failure?.key === key ? failure.message : null,
    // Honest disable, U-6: only "no conversation" and "a write is in flight". The host
    // advertises no write-door flag — `UpNextView` carries `canAdd` per block kind and every
    // write answers with its own refusal — so the old sticky `unavailable` state (one generic
    // failure locked the whole composer for that conversation) is gone rather than guessed at.
    disabled: !key || pending,
    append: (draft, options) => mutate(UP_NEXT_RPC.append, { draft, ...options }),
    update: (blockId, patch) => mutate(UP_NEXT_RPC.update, { blockId, patch }),
    reorder: (blockId, direction) => mutate(UP_NEXT_RPC.reorder, { blockId, direction }),
    remove: (blockId) => mutate(UP_NEXT_RPC.remove, { blockId }),
    commit: () => mutate(UP_NEXT_RPC.commit, {}),
    discardDrafts: () => mutate(UP_NEXT_RPC.discardDrafts, {}),
    configureAfter: (blockId) => mutate(UP_NEXT_RPC.configureAfter, { blockId }),
    requeue: (blockId) => mutate(UP_NEXT_RPC.requeue, { blockId })
  }
}
