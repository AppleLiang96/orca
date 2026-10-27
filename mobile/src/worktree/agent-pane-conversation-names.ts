import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { getAgentRowConversationName } from '../../../src/shared/agent-row-conversation-name'
import { parsePaneKey } from '../../../src/shared/stable-pane-id'

export type AgentPaneTitleSource = {
  readonly title: string | null
  readonly paneTitle?: string
}

// Why: worktree.ps rows carry no tab name, so the phone reads terminal.list's per-pane titles and keys them like agent rows.
export function buildAgentPaneTitleSources(
  terminals: readonly unknown[]
): ReadonlyMap<string, AgentPaneTitleSource> {
  const sources = new Map<string, AgentPaneTitleSource>()
  for (const terminal of terminals) {
    if (!terminal || typeof terminal !== 'object') {
      continue
    }
    const { tabId, leafId, title, paneTitle } = terminal as Record<string, unknown>
    if (typeof tabId !== 'string' || typeof leafId !== 'string') {
      continue
    }
    sources.set(`${tabId}:${leafId}`, {
      title: typeof title === 'string' ? title : null,
      ...(typeof paneTitle === 'string' && paneTitle.trim() ? { paneTitle } : {})
    })
  }
  return sources
}

// Mirror desktop useAgentRowConversationName: a same-tab child row does not own its parent tab's name.
export function agentRowConversationName(
  row: Pick<RuntimeWorktreeAgentRow, 'paneKey' | 'parentPaneKey' | 'agentType'>,
  source: AgentPaneTitleSource | undefined
): string | null {
  if (!source) {
    return null
  }
  if (row.parentPaneKey) {
    const parentTabId = parsePaneKey(row.parentPaneKey)?.tabId
    if (parentTabId !== undefined && parentTabId === parsePaneKey(row.paneKey)?.tabId) {
      return null
    }
  }
  return getAgentRowConversationName(
    { customTitle: source.paneTitle ?? null, title: source.title ?? '' },
    row.agentType,
    false,
    source.title
  )
}
