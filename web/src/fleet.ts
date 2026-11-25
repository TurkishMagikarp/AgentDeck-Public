import { createSignal } from 'solid-js'
import { api } from './api'

export type Overview = {
  at: number
  projects: {
    id: number
    key: string
    name: string
    paused: boolean
    counts: Record<string, number>
    running: number
    costToday: number
    lastActivity: number
  }[]
  running: {
    id: number
    projectKey: string
    projectId: number
    issueNumber: number
    issueTitle: string
    agent: string
    provider: string
    model: string
    startedAt: number
    line: string
  }[]
  inbox: {
    issueId: number
    projectKey: string
    projectId: number
    number: number
    title: string
    priority: number
    since: number
    reason: string
  }[]
  feed: {
    at: number
    projectKey: string
    issueNumber: number
    issueTitle: string
    agent: string
    outcome: string
    costUsd: number
    seconds: number
  }[]
  totals: {
    runs24h: number
    failed24h: number
    cost24h: number
    tokens24h: number
    closed24h: number
    paused: number
    projects: number
  }
  killSwitch: boolean
  guard: { capUsd: number; trippedAt: number; spentUsd: number; perHour: number; hoursLeft: number | null }
  daily: { day: string; runs: number; cost: number; failed: number }[]
  agents: {
    projectKey: string
    agent: string
    provider: string
    runs: number
    done: number
    failed: number
    stopped: number
    successRate: number | null
    avgSeconds: number
    costUsd: number
  }[]
  health: { uptimeSec: number; memoryMb: number; dbMb: number; diskFreeGb: number; diskTotalGb: number }
}

/** The last overview of the whole fleet. The sidebar badge, the tab title and Mission Control read it. */
export const [fleet, setFleet] = createSignal<Overview | null>(null)

let loading = false
export async function refreshFleet() {
  if (loading) return fleet()
  loading = true
  try {
    const next = await api.get<Overview>('/overview')
    setFleet(next)
    return next
  } finally {
    loading = false
  }
}
