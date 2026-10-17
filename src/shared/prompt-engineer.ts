export const PROMPT_ENGINEER_INSTRUCTION = `I want you to become my prompt engineer, helping me craft the best possible prompt. The prompt will be used by you, an LLM. Here's the process we'll follow: you will need to ask me to start my prompt.

I will provide my answer, but we will need to improve it through continual iterations by going through the next steps.

Based on my input, you will generate two sections:

a) Revised prompt (provide your rewritten prompt. It should be clear, concise, and easily understood by you)

b) Questions (ask any relevant questions pertaining to the prompt itself or the type of questions the prompt should be asking).

I will provide feedback on each iteration of the prompt, and we will continue this iterative process with me providing additional information to you and you updating the prompt in the Revised Prompt section until I am satisfied with the final version.`

export type PromptEngineerTurn = { role: 'user' | 'assistant'; text: string }

export function promptEngineerChatInput(input: string): string {
  return `Help me refine this prompt using our conversation as context. Reply with Revised prompt and Questions sections. Keep refining with my feedback; do not execute the task until I press Go.\n\nMy input:\n\n${input}`
}

export function promptEngineerGoInput(input: string): string {
  return `Go. Leave prompt-engineering mode and carry out the latest revised prompt in this conversation. If no revised prompt has been produced, ask me to finish refining it first.${input.trim() ? `\n\nApply these final changes to the revised prompt:\n${input.trim()}` : ''}`
}

export function promptEngineerInput(turns: readonly PromptEngineerTurn[]): string {
  return `${PROMPT_ENGINEER_INSTRUCTION}\n\nWe are drafting the prompt only. Return Revised prompt and Questions; do not execute the task.\n\n${turns.map((turn) => `${turn.role === 'user' ? 'My input' : 'Your previous revision'}:\n${turn.text}`).join('\n\n')}`
}

export function parseEngineeredPrompt(text: string): { revised: string; questions: string } | null {
  const heading =
    /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:[ab][).]\s*)?(Revised prompt|Questions)(?:\*\*)?\s*:?(?:\*\*)?\s*$/gim
  const matches = [...text.matchAll(heading)]
  const revised = matches.find((match) => match[1]!.toLowerCase() === 'revised prompt')
  const questions = matches.find(
    (match) =>
      match[1]!.toLowerCase() === 'questions' && (!revised || match.index! > revised.index!)
  )
  if (!revised || !questions) {
    return null
  }
  const prompt = text
    .slice(revised.index! + revised[0].length, questions.index)
    .trim()
    .replace(/^```(?:\w+)?\s*\n([\s\S]*?)\n```$/, '$1')
    .trim()
  return prompt
    ? { revised: prompt, questions: text.slice(questions.index! + questions[0].length).trim() }
    : null
}
