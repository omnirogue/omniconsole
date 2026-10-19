import { z } from 'zod'
import { specPrBatchStartSchema } from '../../../../shared/spec-pr-batch'
import { getSpecPrBatchService } from '../../../spec-pr-batch/spec-pr-batch-service'
import { defineMethod, type RpcMethod } from '../core'

const id = z.object({ id: z.string().regex(/^spb_[a-f0-9-]{36}$/) }).strict()

export const SPEC_PR_BATCH_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'specPrBatch.available',
    params: null,
    handler: (_params, { runtime }) => ({ enabled: getSpecPrBatchService(runtime).available() })
  }),
  defineMethod({
    name: 'specPrBatch.list',
    params: null,
    handler: (_params, { runtime }) => ({ batches: getSpecPrBatchService(runtime).list() })
  }),
  defineMethod({
    name: 'specPrBatch.start',
    params: specPrBatchStartSchema,
    handler: async (params, { runtime }) => ({
      batch: await getSpecPrBatchService(runtime).start(params)
    })
  }),
  defineMethod({
    name: 'specPrBatch.refresh',
    params: id,
    handler: async (params, { runtime }) => ({
      batch: await getSpecPrBatchService(runtime).refresh(params.id)
    })
  }),
  defineMethod({
    name: 'specPrBatch.stop',
    params: id,
    handler: (params, { runtime }) => ({ batch: getSpecPrBatchService(runtime).stop(params.id) })
  })
]
