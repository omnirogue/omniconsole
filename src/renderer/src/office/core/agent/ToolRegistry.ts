import type { LLMMessage, LLMToolDefinition } from '../llm/types'
import type { AgentNode } from '../../data/agents'
import { translate } from '@/i18n/i18n'
import { setUserBrief } from './tools/setUserBrief'
import { proposeTask } from './tools/proposeTask'
import { completeTask } from './tools/completeTask'
import { deliverProject } from './tools/deliverProject'

export type ToolCall =
  | { name: 'set_user_brief'; args: Parameters<typeof setUserBrief>[1] }
  | { name: 'propose_task'; args: Parameters<typeof proposeTask>[1] }
  | { name: 'complete_task'; args: Parameters<typeof completeTask>[1] }
  | { name: 'deliver_project'; args: Parameters<typeof deliverProject>[1] }

/**
 * Interface that decuples the ToolRegistry from the 3D Simulation (AgentHost).
 * This allows the tool logic to be tested and used independently of the simulation.
 */
export type AgentActionContext = {
  data: Pick<AgentNode, 'index' | 'name' | 'subagents' | 'humanInTheLoop'>
  setState: (state: 'idle' | 'moving' | 'working' | 'on_hold' | 'talking') => void
  appendHistory: (message: LLMMessage) => void
}

export class ToolRegistry {
  /**
   * Processes a tool call by dispatching it to the appropriate tool handler.
   */
  public static process(agent: AgentActionContext, toolCall: ToolCall): boolean {
    const { name, args } = toolCall

    switch (name) {
      case 'set_user_brief':
        return setUserBrief(agent, args)
      case 'propose_task':
        return proposeTask(agent, args)
      case 'complete_task':
        return completeTask(agent, args)
      case 'deliver_project':
        return deliverProject(agent, args)
    }
    console.warn(`[ToolRegistry] Unknown tool: ${String(name)}`)
    return false
  }

  public static getDefinitions(
    agentIndex: number,
    phase: string,
    subagentsCount: number = 0
  ): LLMToolDefinition[] {
    const isLead = agentIndex === 1
    const isManager = subagentsCount > 0
    const tools: LLMToolDefinition[] = []

    // 1. Idle Phase: Only Lead can set the brief
    if (phase === 'idle') {
      if (isLead) {
        tools.push({
          type: 'function',
          function: {
            name: 'set_user_brief',
            description: translate('office.schema.tools.setUserBrief', 'Start project with brief.'),
            parameters: {
              type: 'object',
              properties: { brief: { type: 'string' } },
              required: ['brief']
            }
          }
        })
      }
      return tools
    }

    // 2. Working Phase: Common tools for everyone
    if (phase === 'working') {
      if (isLead || isManager) {
        tools.push({
          type: 'function',
          function: {
            name: 'propose_task',
            description: translate('office.schema.tools.proposeTask', 'Assign task to agent.'),
            parameters: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                agentId: {
                  type: 'integer',
                  description: translate('office.schema.tools.agentIndex', 'Agent index')
                },
                requiresApproval: { type: 'boolean' }
              },
              required: ['title', 'description', 'agentId']
            }
          }
        })
      }

      tools.push({
        type: 'function',
        function: {
          name: 'complete_task',
          description: translate(
            'office.schema.tools.completeTask',
            'Finish task. Output must be raw content, no introductions or credit for the work.'
          ),
          parameters: {
            type: 'object',
            properties: {
              taskId: { type: 'string' },
              output: {
                type: 'string',
                description: translate(
                  'office.schema.tools.taskOutput',
                  'Task result in Markdown (e.g. code blocks, text, or research).'
                )
              }
            },
            required: ['taskId', 'output']
          }
        }
      })

      if (isLead) {
        tools.push({
          type: 'function',
          function: {
            name: 'deliver_project',
            description: translate(
              'office.schema.tools.deliverProject',
              'Final delivery of the full project results.'
            ),
            parameters: {
              type: 'object',
              properties: {
                output: {
                  type: 'string',
                  description: translate(
                    'office.schema.tools.projectOutput',
                    'Full project document in Markdown. NO attribution needed.'
                  )
                }
              },
              required: ['output']
            }
          }
        })
      }
    }

    return tools
  }
}
