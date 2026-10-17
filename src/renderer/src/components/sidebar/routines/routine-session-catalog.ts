import { routineBindingWritePending } from './routine-binding-writes'
import { create } from 'zustand'
import type { RoutineSessionOwner } from '@/lib/routine-backed-session'
import {
  getAutomationHostTargetKey,
  type AutomationHostTarget
} from '@/components/automations/automation-host-client'

export const routineConversationKey = (target: AutomationHostTarget, id: string): string =>
  JSON.stringify([getAutomationHostTargetKey(target), id])

export const useRoutineSessionCatalog = create<{
  owners: RoutineSessionOwner[]
  coverageByTarget: Record<string, 'loading' | 'ready' | 'unavailable'>
  setCoverage: (target: AutomationHostTarget, coverage: 'loading' | 'unavailable') => void
  replace: (target: AutomationHostTarget, rows: RoutineSessionOwner[]) => void
  put: (owner: RoutineSessionOwner) => void
  remove: (target: AutomationHostTarget, id: string) => void
}>((set) => ({
  owners: [],
  coverageByTarget: {},
  setCoverage: (target, coverage) =>
    set((state) => ({
      coverageByTarget: {
        ...state.coverageByTarget,
        [getAutomationHostTargetKey(target)]: coverage
      }
    })),
  replace: (target, rows) =>
    set((state) => ({
      coverageByTarget: {
        ...state.coverageByTarget,
        [getAutomationHostTargetKey(target)]: 'ready'
      },
      owners: [
        ...state.owners.filter(
          (row) =>
            getAutomationHostTargetKey(row.sourceTarget) !== getAutomationHostTargetKey(target)
        ),
        ...rows.map((row) => {
          const key = routineConversationKey(row.sourceTarget, row.automation.id)
          const current = state.owners.find(
            (entry) => routineConversationKey(entry.sourceTarget, entry.automation.id) === key
          )
          return current && routineBindingWritePending(key)
            ? {
                ...row,
                automation: { ...row.automation, conversation: current.automation.conversation }
              }
            : row
        })
      ]
    })),
  put: (owner) =>
    set((state) => ({
      owners: [
        ...state.owners.filter(
          (row) =>
            routineConversationKey(row.sourceTarget, row.automation.id) !==
            routineConversationKey(owner.sourceTarget, owner.automation.id)
        ),
        owner
      ]
    })),
  remove: (target, id) =>
    set((state) => ({
      owners: state.owners.filter(
        (row) =>
          routineConversationKey(row.sourceTarget, row.automation.id) !==
          routineConversationKey(target, id)
      )
    }))
}))
