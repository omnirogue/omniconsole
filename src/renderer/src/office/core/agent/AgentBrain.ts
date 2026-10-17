import type { LLMMessage, LLMToolCall, LLMToolDefinition } from '../llm/types'
import type { AgentNode } from '../../data/agents'

/**
 * AgentBrain — INERT.
 *
 * The original the-delegation drove NPCs with a Gemini LLM (BYOK). In the Omni
 * Console fleet office the sim is driven ENTIRELY by real fleet data pushed into
 * the store by the FleetBridge poller (see integration/fleet/FleetBridge.ts), so
 * there is no LLM and no network here. This class keeps the tiny surface the
 * simulation still calls (think/spark/executeTask/concludeProject/appendHistory)
 * as harmless no-ops. Chat, if opened, returns a canned status line — never a
 * model call.
 */
export type BrainHost = {
  data: AgentNode
  simulation: {
    getAllAgents: () => { data: AgentNode }[]
    processScheduledTasks: () => void
  }
  getCurrentTaskId: () => string | null
}

export type ThinkOptions = {
  isChat?: boolean
  tools?: LLMToolDefinition[]
  silent?: boolean
}

export class AgentBrain {
  private history: LLMMessage[] = []
  public isThinking: boolean = false

  constructor(private readonly host: BrainHost) {}

  public async think(
    _prompt: string,
    _options: ThinkOptions = {}
  ): Promise<{ text: string; toolCalls: LLMToolCall[] }> {
    // No LLM. Return a short, honest status line so the chat panel isn't broken.
    const name = this.host.data?.name ?? 'This agent'
    return {
      text: `${name} is a live view of the Omni Console fleet. This office mirrors real sessions, dispatch and usage — it does not run a chat model.`,
      toolCalls: []
    }
  }

  public async spark(): Promise<void> {
    /* fleet data creates tasks, not the brain */
  }
  public async executeTask(_taskId: string): Promise<void> {
    /* status comes from the BFF */
  }
  public async concludeProject(): Promise<void> {
    /* the fleet has no single "done" */
  }

  public appendHistory(message: LLMMessage): void {
    this.history.push(message)
  }

  public refreshFromStore(): void {
    /* no-op */
  }
}
