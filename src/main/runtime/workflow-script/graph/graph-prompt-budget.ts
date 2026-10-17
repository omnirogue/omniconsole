/**
 * Largest single input handed to one prompt (the most a text answer may hold, so one answer
 * alone is never cut), and the most all inputs of one prompt may add up to.
 */
export const GRAPH_MAX_INPUT_CHARS = 64_000
export const GRAPH_MAX_PROMPT_INPUT_CHARS = 160_000

type BudgetRequest = { length: number; whole: boolean }

/**
 * Every input of one prompt passes through here. A first pass only measures; the second cuts
 * each input to its fair share and says so in the prompt, and the cuts become the run's gaps.
 */
export class GraphInputBudget {
  readonly requests: BudgetRequest[] = []
  readonly cuts: string[] = []
  private index = 0

  constructor(
    private readonly stepTitle: string,
    private readonly limits?: readonly number[],
    private readonly fencer?: (text: string) => string
  ) {}

  /** Model text as a later model must read it in a run that reads pages: fenced, checks after. */
  fence(text: string): string {
    return this.fencer ? this.fencer(text) : text
  }

  get fencing(): boolean {
    return !!this.fencer
  }

  /** How many inputs this prompt has taken so far. */
  get taken(): number {
    return this.index
  }

  /** `whole`: work the call must carry forward entire (a draft to revise) is served first. */
  take(label: string, text: string, options: { whole?: boolean } = {}): string {
    const index = this.index++
    if (!this.limits) {
      this.requests.push({ length: text.length, whole: !!options.whole })
      return text
    }
    const limit = this.limits[index] ?? GRAPH_MAX_INPUT_CHARS
    if (text.length <= limit) {
      return text
    }
    this.cuts.push(
      `${label} was cut to ${limit.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters for ${this.stepTitle}.`
    )
    return `${text.slice(0, limit)}\n\n[… cut: ${(text.length - limit).toLocaleString('en-US')} more characters not shown]`
  }
}

/**
 * Shares the prompt's room: whole inputs first, then the rest equally, a short input leaving
 * what it does not need to the longer ones. Nothing is dropped to nothing while others keep room.
 */
function fairLimits(requests: readonly BudgetRequest[]): number[] {
  const limits = requests.map((request) => Math.min(request.length, GRAPH_MAX_INPUT_CHARS))
  let room = GRAPH_MAX_PROMPT_INPUT_CHARS
  const order = requests.map((_, index) => index)
  for (const index of order.filter((entry) => requests[entry].whole)) {
    limits[index] = Math.min(limits[index], room)
    room -= limits[index]
  }
  const shared = order
    .filter((entry) => !requests[entry].whole)
    .toSorted((left, right) => limits[left] - limits[right] || left - right)
  shared.forEach((index, position) => {
    limits[index] = Math.min(limits[index], Math.floor(room / (shared.length - position)))
    room -= limits[index]
  })
  return limits
}

/** Renders a prompt twice: once to measure its inputs, once to fit them. Pure, so replay-safe. */
export function fitGraphPrompt(
  stepTitle: string,
  render: (budget: GraphInputBudget) => string,
  fencer?: (text: string) => string
): { prompt: string; cuts: string[] } {
  const measured = new GraphInputBudget(stepTitle, undefined, fencer)
  render(measured)
  const budget = new GraphInputBudget(stepTitle, fairLimits(measured.requests), fencer)
  const prompt = render(budget)
  // Each share belongs to one input by position: a render that took different inputs the second
  // time would cut the wrong ones, so it is a bug, never a silent misfit.
  if (budget.taken !== measured.requests.length) {
    throw new Error(
      `The prompt for ${stepTitle} took ${budget.taken} inputs when fitted but ${measured.requests.length} when measured.`
    )
  }
  return { prompt, cuts: budget.cuts }
}
