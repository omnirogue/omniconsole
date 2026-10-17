import { useEffect, useRef, useState } from 'react'
import { handoffApi } from '@/components/handoffs/handoff-client'
import { translate } from '@/i18n/i18n'
import { workflowData, workflowErrorMessage } from '@/lib/console-workflow-client'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import type { ExactHandoffFile } from '../../../../shared/console-handoff-contract'

export type TaskAttachment = { file: ExactHandoffFile; saved?: boolean; error?: string }
const identity = (file: ExactHandoffFile) => `${file.name}:${file.sha256}`

export function useTaskAttachments() {
  const [entries, setEntries] = useState<TaskAttachment[]>([])
  const [capturing, setCapturing] = useState(false)
  const scope = useRef(selectConsoleAccountScope(useAppStore.getState())).current
  const live = useRef(true)
  const busy = useRef(false)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const isCurrent = () =>
    live.current && scope === selectConsoleAccountScope(useAppStore.getState())
  const add = (file: ExactHandoffFile) => {
    if (!isCurrent() || busy.current) {
      return
    }
    if (
      entries.some((entry) => entry.file.name === file.name && entry.file.sha256 !== file.sha256)
    ) {
      throw new Error('Choose a different filename, or remove the earlier file first.')
    }
    setEntries((current) =>
      current.some((entry) => identity(entry.file) === identity(file))
        ? current
        : [...current, { file }]
    )
  }
  const remove = (file: ExactHandoffFile) => {
    if (!busy.current) {
      setEntries((current) => current.filter((entry) => identity(entry.file) !== identity(file)))
    }
  }
  const upload = async (taskId: string, principal?: string): Promise<boolean> => {
    if (busy.current || !isCurrent()) {
      return false
    }
    const pending = entries.filter((entry) => !entry.saved)
    if (!pending.length) {
      return true
    }
    if (!principal) {
      setEntries((current) =>
        current.map((entry) =>
          entry.saved
            ? entry
            : {
                ...entry,
                error: translate(
                  'tasks.filesNeedUpdatedDesktop',
                  'Reopen this task in an updated desktop before attaching files.'
                )
              }
        )
      )
      return false
    }
    busy.current = true
    let complete = true
    try {
      for (const entry of pending) {
        if (!isCurrent()) {
          return false
        }
        let error: string | undefined
        try {
          workflowData(
            await handoffApi().uploadFile({
              taskId,
              file: entry.file,
              purpose: 'task',
              expectedPrincipal: principal
            })
          )
        } catch (reason) {
          complete = false
          error = workflowErrorMessage(reason)
        }
        if (!isCurrent()) {
          return false
        }
        setEntries((current) =>
          current.map((item) =>
            identity(item.file) === identity(entry.file) ? { ...item, saved: !error, error } : item
          )
        )
      }
      return complete
    } finally {
      busy.current = false
    }
  }
  return {
    entries,
    add,
    remove,
    upload,
    capturing,
    setCapturing,
    pending: entries.some((entry) => !entry.saved)
  }
}
