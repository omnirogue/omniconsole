export type ConsoleWorkflowInventory = {
  providers: string[]
  models: {
    id: string
    provider: string
    model: string
    supported_efforts: string[]
    default: boolean
    seat_ready: boolean | null
    aliases: string[]
    hosts?: string[]
  }[]
  people: { id: string; name: string }[]
  repositories: { id: string }[]
  models_fallback: boolean
}
export type ConsoleWorkflowTemplate = {
  id: string
  name: string
  scope: string | null
  status: string | null
  description: string | null
  version: string | null
}

export type ConsoleWorkflowClassifyRequest = {
  draft: string
  companies: {
    slug: string
    name: string
    mission?: string | null
    domains: { id: string; name: string }[]
  }[]
  people: { id: string; name: string }[]
  primary_company_slug?: string | null
}
