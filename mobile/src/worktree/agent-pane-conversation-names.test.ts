import { describe, expect, it } from 'vitest'
import {
  agentRowConversationName,
  buildAgentPaneTitleSources
} from './agent-pane-conversation-names'

const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const CHILD_LEAF = '22222222-2222-4222-8222-222222222222'
const paneKey = `${TAB}:${LEAF}`

describe('buildAgentPaneTitleSources', () => {
  it('keys terminals by tabId:leafId and skips malformed rows', () => {
    const sources = buildAgentPaneTitleSources([
      { handle: 'h1', tabId: TAB, leafId: LEAF, title: '✳ 1007 | 研究', paneTitle: 'Mine' },
      { handle: 'h2', tabId: TAB },
      null
    ])
    expect([...sources.keys()]).toEqual([paneKey])
    expect(sources.get(paneKey)).toEqual({ title: '✳ 1007 | 研究', paneTitle: 'Mine' })
  })
})

describe('agentRowConversationName', () => {
  const agent = { paneKey, parentPaneKey: null, agentType: 'claude' as const }

  it('uses the live terminal title without its agent decoration', () => {
    expect(agentRowConversationName(agent, { title: '✳ 1007 | 研究 | Codex' })).toBe(
      '1007 | 研究 | Codex'
    )
  })

  it('prefers the pane name the user set', () => {
    expect(agentRowConversationName(agent, { title: '✳ 1007', paneTitle: 'Review' })).toBe('Review')
  })

  it('rejects identity, status and cwd titles so the row keeps its preview', () => {
    for (const title of [
      'Claude Code',
      '✳ Claude Code',
      'Done',
      '~/orca/workspaces',
      'Terminal 2'
    ]) {
      expect(agentRowConversationName(agent, { title })).toBeNull()
    }
    expect(agentRowConversationName(agent, undefined)).toBeNull()
  })

  it('does not give a same-tab child row its parent tab name', () => {
    const child = {
      paneKey: `${TAB}:${CHILD_LEAF}`,
      parentPaneKey: paneKey,
      agentType: 'claude' as const
    }
    expect(agentRowConversationName(child, { title: '1007 | 研究' })).toBeNull()
  })
})
