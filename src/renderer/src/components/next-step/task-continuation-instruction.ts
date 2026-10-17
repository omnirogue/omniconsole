import {
  withAgentTemplateInstructions,
  type AgentTemplateText
} from '../../../../shared/agent-template-dispatch'
import { CONSOLE_TASK_CONTINUATION_MAX_INSTRUCTION_CHARS } from '../../../../shared/console-task-continuation'

/** The instruction as sent: with the chosen template, flagged when that passes the wire limit. */
export function taskContinuationInstruction(
  instruction: string,
  template: AgentTemplateText | null
): { instruction: string; tooLong: boolean } {
  const led = withAgentTemplateInstructions(instruction, template)
  return { instruction: led, tooLong: led.length > CONSOLE_TASK_CONTINUATION_MAX_INSTRUCTION_CHARS }
}
