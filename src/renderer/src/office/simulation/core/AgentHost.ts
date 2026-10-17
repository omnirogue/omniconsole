// @ts-nocheck
import type { AgentNode } from '../../data/agents'
import type { LLMMessage, LLMToolCall } from '../../core/llm/types'
import type { AgentState } from '../../types'
import { useUiStore } from '../../integration/store/uiStore'
import type { AgentActionContext } from '../../core/agent/ToolRegistry'
import type { BrainHost, ThinkOptions } from '../../core/agent/AgentBrain'
import { AgentBrain } from '../../core/agent/AgentBrain'
import type { AgentSimulation } from './AgentSimulation'

export class AgentHost implements AgentActionContext, BrainHost {
  public state: AgentState = 'idle'
  private currentTaskId: string | null = null
  public readonly brain: AgentBrain

  constructor(
    public readonly data: AgentNode,
    public readonly simulation: AgentSimulation
  ) {
    this.brain = new AgentBrain(this)
  }

  /** Determines if the agent is currently available to respond to user messages. */
  public canChat(): boolean {
    return this.state === 'idle'
  }

  public async think(
    prompt: string,
    options: ThinkOptions = {}
  ): Promise<{ text: string; toolCalls?: LLMToolCall[] }> {
    return this.brain.think(prompt, options)
  }

  public async spark() {
    return this.brain.spark()
  }

  public async executeTask(taskId: string) {
    return this.brain.executeTask(taskId)
  }

  public async concludeProject() {
    return this.brain.concludeProject()
  }

  public getStatus(): string {
    return `${this.data.name} is ${this.state}${this.currentTaskId ? ` working on ${this.currentTaskId}` : ''}`
  }

  public getCurrentTaskId(): string | null {
    return this.currentTaskId
  }

  public setTask(taskId: string | null) {
    this.currentTaskId = taskId
    this.setState(taskId ? 'working' : 'idle')
  }

  public setState(state: AgentState) {
    this.state = state
    useUiStore.getState().setAgentStatus(this.data.index, state)
  }

  public appendHistory(message: LLMMessage) {
    this.brain.appendHistory(message)
  }

  public get isThinking(): boolean {
    return this.brain.isThinking
  }

  public dispose() {
    // No-op for now
  }
}
