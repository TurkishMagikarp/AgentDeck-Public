// Every running agent gets a token of its own for the agent API. It is valid only while the
// run is alive and only inside the run's project, so an agent can never act with board rights.
import { randomBytes } from 'node:crypto'

export type RunIdentity = {
  runId: number
  projectId: number
  issueId: number
  agentId: number
  agentName: string
}

const tokens = new Map<string, RunIdentity>()

export function createRunToken(identity: RunIdentity) {
  const token = 'run_' + randomBytes(24).toString('hex')
  tokens.set(token, identity)
  return token
}

export function revokeRunToken(runId: number) {
  for (const [token, identity] of tokens) {
    if (identity.runId === runId) tokens.delete(token)
  }
}

export const runOfToken = (token: string) => tokens.get(token)
