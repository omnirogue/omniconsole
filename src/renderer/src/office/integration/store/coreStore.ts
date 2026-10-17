import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { AVAILABLE_MODELS } from '../../core/llm/constants'
import { useTeamStore } from './teamStore'
import { createCoreTaskActions } from './coreTaskActions'
import { createCoreLogActions } from './coreLogActions'
import type { CoreState } from './coreStoreTypes'

export type {
  TaskStatus,
  TaskRevision,
  Task,
  ActionLogEntry,
  DebugLogEntryBase,
  RequestDebugLogEntry,
  ResponseDebugLogEntry,
  DebugLogEntry,
  ProjectPhase,
  FinalAssetParams
} from './coreStoreTypes'

const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

export const useCoreStore = create<CoreState>()(
  persist(
    (set) => ({
      userBrief: '',
      referenceImages: [],
      phase: 'idle',
      finalOutput: null,
      availableModels: [...AVAILABLE_MODELS.text],
      totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      agentTokenUsage: {},
      totalEstimatedCost: 0,
      agentEstimatedCost: {},
      finalAssetType: 'text',
      finalAssetContent: null,
      isGeneratingAsset: false,
      isReviewingOutput: false,
      pendingOutputPrompt: '',
      pendingOutputParams: {},
      tasks: [],
      actionLog: [],
      debugLog: [],
      agentHistories: {},
      agentSummaries: {},
      boardroomHistories: {},
      isKanbanOpen: true,
      isLogOpen: true,
      isFinalOutputOpen: false,
      logFilterAgentIndex: null,
      isResizing: false,
      viewMode: 'simulation',

      setViewMode: (viewMode) => set({ viewMode }),

      resetProject: () =>
        set({
          userBrief: '',
          phase: 'idle',
          finalOutput: null,
          tasks: [],
          actionLog: [],
          debugLog: [],
          agentHistories: {},
          agentSummaries: {},
          boardroomHistories: {},
          isFinalOutputOpen: false,
          totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          agentTokenUsage: {},
          totalEstimatedCost: 0,
          agentEstimatedCost: {},
          finalAssetType: 'text',
          finalAssetContent: null,
          isGeneratingAsset: false,
          isReviewingOutput: false,
          pendingOutputPrompt: '',
          pendingOutputParams: {},
          referenceImages: []
        }),

      setUserBrief: (brief) => set({ userBrief: brief }),
      addReferenceImage: (base64) =>
        set((s) => ({
          referenceImages: [...s.referenceImages, base64].slice(0, 3)
        })),
      removeReferenceImage: (index) =>
        set((s) => ({
          referenceImages: s.referenceImages.filter((_, i) => i !== index)
        })),
      clearReferenceImages: () => set({ referenceImages: [] }),
      setPhase: (phase) => set({ phase }),
      startProject: (brief) =>
        set({
          userBrief: brief,
          phase: 'working',
          finalAssetType: 'text',
          finalAssetContent: null
        }),
      setFinalOutput: (output) => set({ finalOutput: output }),
      setFinalAsset: (type, content) =>
        set({ finalAssetType: type, finalAssetContent: content, isGeneratingAsset: false }),
      setIsGeneratingAsset: (isGenerating) => set({ isGeneratingAsset: isGenerating }),
      setReviewingOutput: (val) => set({ isReviewingOutput: val }),
      setPendingOutputPrompt: (prompt) => set({ pendingOutputPrompt: prompt }),
      setPendingOutputParams: (params) => set({ pendingOutputParams: params }),

      ...createCoreTaskActions(set, uid),

      ...createCoreLogActions(set, uid),

      appendAgentHistory: (agentIndex, role, parts) =>
        set((s) => ({
          agentHistories: {
            ...s.agentHistories,
            [agentIndex]: [
              ...(s.agentHistories[agentIndex] ?? []),
              {
                role,
                content: Array.isArray(parts)
                  ? parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
                  : String(parts)
              }
            ]
          }
        })),

      setAgentSummary: (agentIndex, summary) =>
        set((s) => ({
          agentSummaries: {
            ...s.agentSummaries,
            [agentIndex]: summary
          }
        })),

      appendBoardroomHistory: (taskId, role, parts) =>
        set((s) => ({
          boardroomHistories: {
            ...s.boardroomHistories,
            [taskId]: [
              ...(s.boardroomHistories[taskId] ?? []),
              {
                role,
                content: Array.isArray(parts)
                  ? parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
                  : String(parts)
              }
            ]
          }
        })),

      clearAllHistories: () => set({ agentHistories: {}, boardroomHistories: {} }),

      setKanbanOpen: (open) => set({ isKanbanOpen: open }),
      setLogOpen: (open, filterAgent = null) =>
        set({ isLogOpen: open, logFilterAgentIndex: filterAgent ?? null }),
      setFinalOutputOpen: (open) => set({ isFinalOutputOpen: open }),
      setIsResizing: (resizing) => set({ isResizing: resizing }),

      setAgentHistory: (agentIndex, history) =>
        set((s) => ({
          agentHistories: { ...s.agentHistories, [agentIndex]: history }
        }))
    }),
    {
      name: 'core-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: () => ({})
    }
  )
)

// Sync resetProject whenever the active team changes
useTeamStore.subscribe((state, prevState) => {
  if (state.selectedAgentSetId !== prevState.selectedAgentSetId) {
    useCoreStore.getState().resetProject()
  }
})
