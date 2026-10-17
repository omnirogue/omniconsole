import type { StoreApi } from 'zustand'
import type {
  LLMContentPart,
  LLMMessage,
  LLMRequestDetails,
  LLMResponse,
  LLMTokenUsage,
  LLMToolCall
} from '../../core/llm/types'

export type FinalAssetParams = {
  model?: string
  aspectRatio?: string
  imageSize?: string
  resolution?: string
  durationSeconds?: number
}

export type TaskStatus = 'scheduled' | 'on_hold' | 'in_progress' | 'done'

export type TaskRevision = {
  output: string
  feedback?: string
  timestamp: number
}

export type Task = {
  id: string
  title: string
  description: string
  assignedAgentId: number
  status: TaskStatus
  parentTaskId?: string
  requiresUserApproval: boolean
  draftOutput?: string
  reviewComments?: string
  output?: string
  revisions: TaskRevision[]
  createdAt: number
  updatedAt: number
}

export type ActionLogEntry = {
  id: string
  timestamp: number
  agentIndex: number
  action: string
  taskId?: string
}

export type DebugLogEntryBase = {
  id: string
  timestamp: number
  agentIndex: number
  agentName: string
  status: 'pending' | 'completed' | 'error'
  taskId?: string
}

export type RequestDebugLogEntry = {
  phase: 'request'
  systemInstruction?: string
  contents: LLMRequestDetails['contents']
  systemTools?: LLMRequestDetails['tools']
} & DebugLogEntryBase

export type ResponseDebugLogEntry = {
  phase: 'response'
  content: string | null
  tool_calls?: LLMToolCall[]
  usage?: LLMTokenUsage
  raw?: LLMResponse['raw']
} & DebugLogEntryBase

export type DebugLogEntry = RequestDebugLogEntry | ResponseDebugLogEntry

export type ProjectPhase = 'idle' | 'working' | 'done'

export type CoreState = {
  // ── Project ──────────────────────────────────────────────────
  userBrief: string
  referenceImages: string[]
  phase: ProjectPhase
  finalOutput: string | null
  availableModels: string[]
  totalTokenUsage: LLMTokenUsage
  agentTokenUsage: Record<number, LLMTokenUsage>
  totalEstimatedCost: number
  agentEstimatedCost: Record<number, number>
  finalAssetType: 'text' | 'image' | 'audio' | 'video'
  finalAssetContent: string | null
  isGeneratingAsset: boolean

  // ── Output Review ────────────────────────────────────────────
  isReviewingOutput: boolean
  pendingOutputPrompt: string
  pendingOutputParams: FinalAssetParams

  // ── Tasks ────────────────────────────────────────────────────
  tasks: Task[]

  // ── Log ──────────────────────────────────────────────────────
  actionLog: ActionLogEntry[]
  debugLog: DebugLogEntry[]

  // ── Conversation histories (Agnostic standard) ───────────────
  agentHistories: Record<number, LLMMessage[]>
  agentSummaries: Record<number, string>
  boardroomHistories: Record<string, LLMMessage[]>

  // ── UI ───────────────────────────────────────────────────────
  isKanbanOpen: boolean
  viewMode: 'simulation' | 'design'
  isLogOpen: boolean
  isFinalOutputOpen: boolean
  logFilterAgentIndex: number | null
  isResizing: boolean

  // ── Actions — Project —————————————————————————————————────────
  setUserBrief: (brief: string) => void
  addReferenceImage: (base64: string) => void
  removeReferenceImage: (index: number) => void
  clearReferenceImages: () => void
  setPhase: (phase: ProjectPhase) => void
  startProject: (brief: string) => void
  setFinalOutput: (output: string) => void
  setFinalAsset: (type: 'image' | 'audio' | 'video', content: string) => void
  setIsGeneratingAsset: (isGenerating: boolean) => void
  setReviewingOutput: (val: boolean) => void
  setPendingOutputPrompt: (prompt: string) => void
  setPendingOutputParams: (params: FinalAssetParams) => void

  // ── Actions — Tasks ───────────────────────────────────────────
  addTask: (task: Omit<Task, 'id' | 'revisions' | 'createdAt' | 'updatedAt'>) => Task
  removeTask: (taskId: string) => void
  updateTaskStatus: (taskId: string, status: TaskStatus) => void
  submitTaskForReview: (taskId: string, draftOutput?: string) => void
  setTaskOutput: (taskId: string, output: string) => void
  approveTask: (taskId: string) => void
  rejectTask: (taskId: string, comments: string) => void

  // ── Actions — Log ─────────────────────────────────────────────
  addLogEntry: (entry: Omit<ActionLogEntry, 'id' | 'timestamp'>) => void
  addRequestLog: (
    entry: Omit<RequestDebugLogEntry, 'id' | 'timestamp' | 'phase' | 'status'>
  ) => void
  addResponseLog: (
    entry: Omit<ResponseDebugLogEntry, 'id' | 'timestamp' | 'phase' | 'status'>
  ) => void

  // ── Actions — History ───────────────────────────────────────
  appendAgentHistory: (
    agentIndex: number,
    role: 'user' | 'assistant',
    parts: (string | LLMContentPart)[]
  ) => void
  setAgentSummary: (agentIndex: number, summary: string) => void
  appendBoardroomHistory: (
    taskId: string,
    role: 'user' | 'assistant',
    parts: (string | LLMContentPart)[]
  ) => void
  clearAllHistories: () => void

  // ── Actions — UI ──────────────────────────────────────────────
  setKanbanOpen: (open: boolean) => void
  setLogOpen: (open: boolean, filterAgent?: number | null) => void
  setFinalOutputOpen: (open: boolean) => void
  setIsResizing: (isResizing: boolean) => void
  resetProject: () => void
  setViewMode: (mode: 'simulation' | 'design') => void

  // ── Simulation Sync ──────────────────────────────────────────
  setAgentHistory: (agentIndex: number, history: LLMMessage[]) => void
}

export type CoreStateSetter = StoreApi<CoreState>['setState']
