export type OmnisiTeamStatus = {
  enabled: boolean
  connected: boolean
  server?: string
  team?: string
  error?: string
}
export type OmnisiTeamApi = {
  status(): Promise<OmnisiTeamStatus>
  enable(enabled: boolean): Promise<OmnisiTeamStatus>
  connect(server: string, key: string): Promise<OmnisiTeamStatus>
  disconnect(): Promise<OmnisiTeamStatus>
}
