import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { sessionTerminalListRead } from '../session/mobile-session-read-operations'
import {
  buildAgentPaneTitleSources,
  type AgentPaneTitleSource
} from './agent-pane-conversation-names'

const EMPTY_SOURCES: ReadonlyMap<string, AgentPaneTitleSource> = new Map()
// The list refreshes on every agent update; titles change rarely, so cap host round-trips.
const MIN_REFRESH_INTERVAL_MS = 10_000
const TERMINAL_LIST_LIMIT = 1000

export const AgentPaneTitlesContext =
  createContext<ReadonlyMap<string, AgentPaneTitleSource>>(EMPTY_SOURCES)

export function useAgentPaneTitleSource(paneKey: string): AgentPaneTitleSource | undefined {
  return useContext(AgentPaneTitlesContext).get(paneKey)
}

// Change refreshKey when the workspace list changes; a refusal or transport error keeps the previous titles.
export function useAgentPaneTitles(
  client: RpcClient | null | undefined,
  refreshKey: unknown
): ReadonlyMap<string, AgentPaneTitleSource> {
  const [sources, setSources] = useState<ReadonlyMap<string, AgentPaneTitleSource>>(EMPTY_SOURCES)
  const lastRequestAtRef = useRef(0)
  const [retryTick, setRetryTick] = useState(0)
  // Only a client change voids an in-flight reply; frequent list updates must not starve it.
  const currentClientRef = useRef(client)
  currentClientRef.current = client

  useEffect(() => {
    setSources(EMPTY_SOURCES)
    lastRequestAtRef.current = 0
  }, [client])

  useEffect(() => {
    if (!client) {
      return
    }
    const wait = lastRequestAtRef.current + MIN_REFRESH_INTERVAL_MS - Date.now()
    if (wait > 0) {
      // Coalesce bursts into one trailing refresh instead of dropping the latest change.
      const timer = setTimeout(() => setRetryTick((tick) => tick + 1), wait)
      return () => clearTimeout(timer)
    }
    lastRequestAtRef.current = Date.now()
    void sessionTerminalListRead
      .request(client, { limit: TERMINAL_LIST_LIMIT, includeVisualLayouts: false })
      .then((reply) => {
        const response = sessionTerminalListRead.interpret(reply)
        if (currentClientRef.current === client && response.accepted) {
          setSources(buildAgentPaneTitleSources(response.value.terminals))
        }
      })
      .catch(() => {})
    return undefined
  }, [client, refreshKey, retryTick])

  return sources
}
