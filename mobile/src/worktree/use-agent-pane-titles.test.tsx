import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { AgentPaneTitleSource } from './agent-pane-conversation-names'
import { useAgentPaneTitles } from './use-agent-pane-titles'

type Pending = { resolve: (response: unknown) => void }

const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB}:${LEAF}`

// Defer terminal.list replies to control their arrival order.
function mountTitles() {
  const pending: Pending[] = []
  let latest: ReadonlyMap<string, AgentPaneTitleSource> = new Map()
  const client = {
    sendRequest: () => new Promise<unknown>((resolve) => pending.push({ resolve }))
  } as unknown as RpcClient

  function Probe({ refreshKey }: { refreshKey: string }) {
    latest = useAgentPaneTitles(client, refreshKey)
    return null
  }

  let renderer!: ReturnType<typeof create>
  act(() => {
    renderer = create(createElement(Probe, { refreshKey: 'a' }))
  })
  return {
    get title(): string | null | undefined {
      return latest.get(PANE_KEY)?.title
    },
    get requestCount(): number {
      return pending.length
    },
    rerender(refreshKey: string) {
      act(() => {
        renderer.update(createElement(Probe, { refreshKey }))
      })
    },
    async advance(ms: number) {
      await act(async () => {
        vi.advanceTimersByTime(ms)
      })
    },
    async settle(index: number, title: string) {
      await act(async () => {
        pending[index]!.resolve({
          ok: true,
          result: { terminals: [{ handle: `h${index}`, tabId: TAB, leafId: LEAF, title }] }
        })
      })
    }
  }
}

describe('useAgentPaneTitles', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the newest reply when an older request answers last', async () => {
    const titles = mountTitles()
    titles.rerender('b')
    await titles.advance(10_000)
    expect(titles.requestCount).toBe(2)
    await titles.settle(1, 'new name')
    await titles.settle(0, 'old name')
    expect(titles.title).toBe('new name')
  })

  it('re-reads titles while connected even when the list does not change', async () => {
    const titles = mountTitles()
    await titles.settle(0, 'before rename')
    expect(titles.requestCount).toBe(1)
    await titles.advance(30_000)
    expect(titles.requestCount).toBe(2)
    await titles.settle(1, 'after rename')
    expect(titles.title).toBe('after rename')
  })
})
