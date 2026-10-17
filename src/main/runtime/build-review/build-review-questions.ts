import type {
  BuildReviewPendingQuestion,
  BuildReviewPipelineSnapshot
} from '../../../shared/build-review-pipeline'
import {
  WorkerUnitRegistry,
  type WorkerUnitLike,
  type WorkerUnitQuestion
} from './build-review-worker-registry'

function openQuestions(pipeline: BuildReviewPipelineSnapshot): BuildReviewPendingQuestion[] {
  return pipeline.pendingQuestions ?? (pipeline.pendingQuestion ? [pipeline.pendingQuestion] : [])
}

function owns(question: BuildReviewPendingQuestion, worker: WorkerUnitLike): boolean {
  return question.dispatchId
    ? question.dispatchId === worker.dispatchId
    : question.role === worker.role
}

function store(pipeline: BuildReviewPipelineSnapshot, questions: BuildReviewPendingQuestion[]) {
  pipeline.pendingQuestions = questions
  pipeline.pendingQuestion = questions[0] ?? null
}

/** The open question this worker asked, or null. */
export function pipelineQuestionFor(
  pipeline: BuildReviewPipelineSnapshot,
  worker: WorkerUnitLike
): WorkerUnitQuestion | null {
  return openQuestions(pipeline).find((question) => owns(question, worker)) ?? null
}

export function setPipelineQuestion(
  pipeline: BuildReviewPipelineSnapshot,
  worker: WorkerUnitLike,
  question: WorkerUnitQuestion | null
): void {
  const rest = openQuestions(pipeline).filter((open) => !owns(open, worker))
  store(
    pipeline,
    question
      ? [
          ...rest,
          {
            messageId: question.messageId,
            role: worker.role as BuildReviewPendingQuestion['role'],
            question: question.question,
            options: question.options,
            askedAt: question.askedAt,
            ...(worker.dispatchId ? { dispatchId: worker.dispatchId } : {})
          }
        ]
      : rest
  )
}

export function answerPipelineQuestion(
  pipeline: BuildReviewPipelineSnapshot,
  messageId: string
): void {
  store(
    pipeline,
    openQuestions(pipeline).filter((question) => question.messageId !== messageId)
  )
}

/** A Run registry whose worker questions live on the pipeline, where the page and replies read them. */
export class BuildReviewWorkerRegistry extends WorkerUnitRegistry {
  constructor(private readonly pipeline: BuildReviewPipelineSnapshot) {
    super()
  }

  override pendingQuestionFor(worker: WorkerUnitLike): WorkerUnitQuestion | null {
    return pipelineQuestionFor(this.pipeline, worker)
  }

  override setPendingQuestion(worker: WorkerUnitLike, question: WorkerUnitQuestion | null): void {
    setPipelineQuestion(this.pipeline, worker, question)
  }
}
