import type { CoreState, CoreStateSetter, DebugLogEntry } from './coreStoreTypes'
import { calculateCost } from '../../core/llm/pricing'
import { useUiStore } from './uiStore'

type CoreLogActions = Pick<CoreState, 'addLogEntry' | 'addRequestLog' | 'addResponseLog'>

export function createCoreLogActions(set: CoreStateSetter, uid: () => string): CoreLogActions {
  return {
    addLogEntry: (entry) =>
      set((s) => ({
        actionLog: [...s.actionLog, { ...entry, id: `log_${uid()}`, timestamp: Date.now() }]
      })),

    addRequestLog: (entry) =>
      set((s) => {
        const newEntry: DebugLogEntry = {
          ...entry,
          id: `debug_${uid()}`,
          timestamp: Date.now(),
          phase: 'request',
          status: 'completed'
        }
        const updated = [...s.debugLog, newEntry]
        return { debugLog: updated.length > 30 ? updated.slice(-30) : updated }
      }),

    addResponseLog: (entry) =>
      set((s) => {
        const newEntry: DebugLogEntry = {
          ...entry,
          id: `debug_${uid()}`,
          timestamp: Date.now(),
          phase: 'response',
          status: 'completed'
        }
        const updated = [...s.debugLog, newEntry]

        // Update token usage and estimated cost
        let nextTotalUsage = s.totalTokenUsage
        let nextAgentUsage = { ...s.agentTokenUsage }
        let nextTotalCost = s.totalEstimatedCost
        let nextAgentCost = { ...s.agentEstimatedCost }

        if (entry.usage) {
          const modelName = entry.raw?.model || useUiStore.getState().llmConfig.model
          // For multimodal outputs, we might need to pass the duration/count if available in raw
          const durationOrCount = entry.raw?.duration || entry.raw?.count
          const callCost = calculateCost(
            entry.usage.promptTokens,
            entry.usage.completionTokens,
            modelName,
            durationOrCount
          )

          nextTotalCost += callCost
          nextAgentCost[entry.agentIndex] = (s.agentEstimatedCost[entry.agentIndex] || 0) + callCost

          nextTotalUsage = {
            promptTokens: s.totalTokenUsage.promptTokens + entry.usage.promptTokens,
            completionTokens: s.totalTokenUsage.completionTokens + entry.usage.completionTokens,
            totalTokens: s.totalTokenUsage.totalTokens + entry.usage.totalTokens
          }

          const currentAgentUsage = s.agentTokenUsage[entry.agentIndex] || {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0
          }
          nextAgentUsage[entry.agentIndex] = {
            promptTokens: currentAgentUsage.promptTokens + entry.usage.promptTokens,
            completionTokens: currentAgentUsage.completionTokens + entry.usage.completionTokens,
            totalTokens: currentAgentUsage.totalTokens + entry.usage.totalTokens
          }
        }

        return {
          debugLog: updated.length > 30 ? updated.slice(-30) : updated,
          totalTokenUsage: nextTotalUsage,
          agentTokenUsage: nextAgentUsage,
          totalEstimatedCost: nextTotalCost,
          agentEstimatedCost: nextAgentCost
        }
      })
  }
}
