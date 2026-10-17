import { z } from 'zod'

/**
 * `work-plan-v1` — the document a Plan Mode step delivers.
 *
 * Why a schema at all: a `file` condition proves only that bytes exist at a path, so a 0-byte
 * `plan.json` satisfied a plan outcome (arch v5 F12). A file condition may now pin
 * `schema: 'work-plan-v1'`; the execution host parses the delivered bytes against THIS schema and
 * refuses the receipt when they do not match. The schema is therefore a contract with the planner
 * agent as much as a check: every field here is one the person reads in View Plan.
 */
export const WORK_PLAN_ARTIFACT_SCHEMA = 'work-plan-v1'

const line = z.string().trim().min(1).max(400)
const prose = z.string().trim().min(1).max(20_000)
const list = <T extends z.ZodTypeAny>(item: T) => z.array(item).max(100)

/**
 * A deliverable path is relative to the workspace and cannot leave it. The evaluator additionally
 * requires a mockup to sit inside the step's own output dir; this is the shape check that keeps an
 * absolute path or a `..` escape out of the document in the first place.
 */
export const workPlanArtifactPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine((path) => !/^(?:[/\\]|[A-Za-z]:[/\\])/.test(path), 'Use a workspace-relative path.')
  .refine(
    (path) => !path.split(/[/\\]/).includes('..'),
    'A plan path may not climb out of the workspace.'
  )

export const workPlanArtifactStepSchema = z
  .object({
    /** 1-based position; `dependsOn` may only name a smaller `n`, so a plan can never cycle. */
    n: z.number().int().positive().max(500),
    title: line,
    detail: prose,
    /** The files this step touches, so a reader can see the blast radius before anyone writes. */
    files: list(workPlanArtifactPathSchema),
    /** Who does it: an actor id, a role, or a person's name. Prose, never resolved to a seat. */
    owner: line,
    dependsOn: z.array(z.number().int().positive().max(500)).max(64)
  })
  .strict()

export const workPlanArtifactMockupSchema = z
  .object({ file: workPlanArtifactPathSchema, title: line })
  .strict()

export const workPlanArtifactSchema = z
  .object({
    /** Self-identification, so a file found on disk says what it is. Optional for compatibility. */
    schema: z.literal(WORK_PLAN_ARTIFACT_SCHEMA).optional(),
    title: line,
    summary: prose,
    assumptions: list(line).default([]),
    steps: z.array(workPlanArtifactStepSchema).min(1).max(200),
    risks: list(line).default([]),
    openQuestions: list(line).default([]),
    mockups: z.array(workPlanArtifactMockupSchema).max(50).default([]),
    /** What it is expected to cost, in the planner's own words ("about two days"). */
    estimate: line.optional()
  })
  .strict()
  .superRefine((plan, ctx) => {
    const seen = new Set<number>()
    for (const [index, step] of plan.steps.entries()) {
      if (seen.has(step.n)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'n'],
          message: `Step number ${step.n} is used twice.`
        })
      }
      seen.add(step.n)
      for (const [position, dependency] of step.dependsOn.entries()) {
        // Why "earlier" and not "any other step": a plan a person can execute has an order, and
        // refusing forward references is the cheapest proof that the dependency graph is acyclic.
        if (dependency >= step.n || !plan.steps.some((entry) => entry.n === dependency)) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', index, 'dependsOn', position],
            message: `Step ${step.n} depends on ${dependency}, which is not an earlier step.`
          })
        }
      }
    }
    const files = plan.mockups.map((mockup) => mockup.file)
    if (new Set(files).size !== files.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['mockups'],
        message: 'Two mockups name the same file.'
      })
    }
  })

export type WorkPlanArtifact = z.infer<typeof workPlanArtifactSchema>
export type WorkPlanArtifactStep = z.infer<typeof workPlanArtifactStepSchema>
export type WorkPlanArtifactMockup = z.infer<typeof workPlanArtifactMockupSchema>

export type WorkPlanArtifactResult =
  | { ok: true; plan: WorkPlanArtifact }
  | { ok: false; problem: string }

function firstProblem(error: z.ZodError): string {
  const issue = error.issues[0]
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
  return `${where}${issue?.message ?? 'The plan document does not match work-plan-v1.'}`
}

/** Parse an already-decoded value. The problem names the first offending field, never the bytes. */
export function parseWorkPlanArtifact(value: unknown): WorkPlanArtifactResult {
  const parsed = workPlanArtifactSchema.safeParse(value)
  return parsed.success
    ? { ok: true, plan: parsed.data }
    : { ok: false, problem: firstProblem(parsed.error) }
}

/** Parse delivered bytes. An empty file is a missing plan, not a malformed one; both are refused. */
export function readWorkPlanArtifact(text: string): WorkPlanArtifactResult {
  if (!text.trim()) {
    return { ok: false, problem: 'The plan document is empty.' }
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      problem: `The plan document is not JSON: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return parseWorkPlanArtifact(decoded)
}
