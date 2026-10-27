import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import type { CodexAppServerInvocation } from './codex-app-server-session'
import { createCodexAtRestSkillCatalog } from './codex-at-rest-skills-probe'

function floatingCodexChat(sessionId: string, launchDirectory: string) {
  return agentSessionRecordFixture({
    sessionId,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/me/.codex' },
    launchDirectory,
    location: { workspaceId: FLOATING_TERMINAL_WORKTREE_ID }
  })
}

/** Answers skills/list with one entry per requested folder, as Codex does. */
function listingRpc(onRequest?: (params: unknown) => void) {
  return {
    request: async (_method: string, params?: Record<string, unknown>) => {
      onRequest?.(params)
      const cwds = Array.isArray(params?.cwds) ? params.cwds.map(String) : []
      return {
        data: cwds.map((cwd) => {
          const name = `${cwd.split('/').at(-1)}-skill`
          return { cwd, skills: [{ name, path: `${cwd}/${name}/SKILL.md` }] }
        })
      }
    },
    notify: () => {}
  }
}

describe('a resting Codex chat lists the skills Codex would load', () => {
  it('answers every pinned folder from one probe before it settles, which then ends the whole tree', async () => {
    const invocations: CodexAppServerInvocation[] = []
    const settling: (() => void)[] = []
    const catalog = createCodexAtRestSkillCatalog({
      resolveWorkspacePath: async () => '/unused',
      resolveLaunchArgs: () => [
        '--disable',
        'plugins',
        '-c',
        'features.test=true',
        '--sandbox',
        'read-only'
      ],
      resolveEnvironment: async () => ({ PATH: '/bin', CUSTOM_AGENT_ENV: 'configured' }),
      resolveCommand: () => '/bin/codex',
      sleep: () => new Promise((resolve) => settling.push(resolve)),
      runSession: async (invocation, body) => {
        invocations.push(invocation)
        return body(listingRpc())
      }
    })
    const one = floatingCodexChat('one', '/work/one')
    const two = floatingCodexChat('two', '/work/two')

    expect(catalog.read(one)).toBeUndefined()
    expect(catalog.read(two)).toBeUndefined()
    await Promise.all([catalog.settled(one, 1_000), catalog.settled(two, 1_000)])

    expect(catalog.read(one)?.filter((row) => row.kind === 'skill')).toEqual([
      { name: 'one-skill', kind: 'skill', path: '/work/one/one-skill/SKILL.md' }
    ])
    expect(catalog.read(two)?.filter((row) => row.kind === 'skill')).toEqual([
      { name: 'two-skill', kind: 'skill', path: '/work/two/two-skill/SKILL.md' }
    ])
    expect(invocations.map((invocation) => invocation.args)).toEqual([
      ['--disable', 'plugins', '-c', 'features.test=true', 'app-server']
    ])
    // A settling probe must not hold the folder open, or Windows cannot remove the worktree.
    expect(invocations[0]?.cwd?.startsWith('/work')).toBe(false)
    expect(invocations[0]?.treeKillOnFinish).toBe(true)
    expect(invocations[0]?.env).toMatchObject({
      CODEX_HOME: '/home/me/.codex',
      CUSTOM_AGENT_ENV: 'configured'
    })
    expect(invocations[0]?.envToDelete).toEqual(['ORCA_CHAT_SCRATCH_DIR', 'ORCA_CHAT_VISUALS_DIR'])
    expect(settling).toHaveLength(1)
    settling.forEach((resolve) => resolve())
  })

  it('keeps probe processes bounded however many resting folders ask', async () => {
    let clock = 0
    let live = 0
    let peak = 0
    const spawned: string[] = []
    const settling: (() => void)[] = []
    const catalog = createCodexAtRestSkillCatalog({
      resolveWorkspacePath: async () => '/unused',
      resolveLaunchArgs: () => [],
      resolveEnvironment: async () => ({ PATH: '/bin' }),
      resolveCommand: () => '/bin/codex',
      now: () => clock,
      sleep: () => new Promise((resolve) => settling.push(resolve)),
      runSession: async (invocation, body) => {
        spawned.push(String(invocation.env?.CODEX_HOME))
        live += 1
        peak = Math.max(peak, live)
        try {
          return await body(listingRpc())
        } finally {
          // Counted until teardown ends, as the process slot is.
          await Promise.resolve()
          live -= 1
        }
      }
    })
    const chats = Array.from({ length: 160 }, (_, index) =>
      agentSessionRecordFixture({
        sessionId: `chat-${index}`,
        provider: 'codex',
        accountHome: { variable: 'CODEX_HOME', path: `/home/account-${index % 3}` },
        launchDirectory: `/work/w${index}`,
        location: { workspaceId: FLOATING_TERMINAL_WORKTREE_ID }
      })
    )
    const readAll = () => chats.forEach((chat) => catalog.read(chat))
    catalog.onChange(readAll)
    readAll()
    await vi.waitFor(() => expect(settling).toHaveLength(2))
    expect(live).toBe(2)
    // The third account waits for a slot instead of starting a third process.
    clock += 70_000
    settling.splice(0).forEach((resolve) => resolve())
    await vi.waitFor(() => expect(settling).toHaveLength(1))
    expect(spawned.toSorted()).toEqual(['/home/account-0', '/home/account-1', '/home/account-2'])
    clock += 70_000
    settling.splice(0).forEach((resolve) => resolve())
    await Promise.all(chats.map((chat) => catalog.settled(chat, 1_000)))
    for (const [index, chat] of chats.entries()) {
      expect(catalog.read(chat)?.find((row) => row.kind === 'skill')?.name).toBe(`w${index}-skill`)
    }
    expect(peak).toBe(2)
    // Repeated reads inside the TTL start nothing.
    for (let round = 0; round < 10; round += 1) {
      readAll()
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(spawned).toHaveLength(3)
  })

  it('reloads a live probe after an explicit refresh instead of handing back its cached list', async () => {
    const asked: unknown[] = []
    const settling: (() => void)[] = []
    const catalog = createCodexAtRestSkillCatalog({
      resolveWorkspacePath: async () => '/unused',
      resolveLaunchArgs: () => [],
      resolveCommand: () => '/bin/codex',
      now: () => 0,
      sleep: () => new Promise((resolve) => settling.push(resolve)),
      runSession: async (_invocation, body) =>
        body(
          listingRpc((params) => {
            asked.push(params)
          })
        )
    })
    const chat = floatingCodexChat('one', '/work/one')
    catalog.read(chat)
    await catalog.settled(chat, 1_000)
    catalog.retireContext()
    catalog.read(chat)
    await catalog.settled(chat, 1_000)
    expect(asked).toEqual([{ cwds: ['/work/one'] }, { cwds: ['/work/one'], forceReload: true }])
    expect(settling).toHaveLength(1)
    settling.forEach((resolve) => resolve())
  })

  it('backs off a probe that cannot start, and a refresh does not reset that', async () => {
    let spawns = 0
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const catalog = createCodexAtRestSkillCatalog({
      resolveWorkspacePath: async () => '/unused',
      resolveLaunchArgs: () => [],
      resolveCommand: () => '/bin/codex',
      now: () => 0,
      runSession: async () => {
        spawns += 1
        throw new Error('spawn codex ENOENT')
      }
    })
    try {
      const chat = floatingCodexChat('one', '/work/one')
      catalog.read(chat)
      await catalog.settled(chat, 1_000)
      catalog.retireContext()
      catalog.read(chat)
      await catalog.settled(chat, 1_000)
      expect(spawns).toBe(1)
      expect(warned).toHaveBeenCalledTimes(2)
    } finally {
      warned.mockRestore()
    }
  })

  it.each(['method not found', 'temporary failure'])(
    'retains the floor after %s without holding the answer',
    async (message) => {
      const floor = Promise.withResolvers<void>()
      let closed = false
      const sleep = vi.fn(() => floor.promise)
      const catalog = createCodexAtRestSkillCatalog({
        resolveWorkspacePath: async () => '/work',
        resolveLaunchArgs: () => [],
        resolveCommand: () => '/bin/codex',
        now: () => 0,
        sleep,
        runSession: async (_invocation, body) => {
          try {
            return await body({
              request: async () => {
                throw new Error(message)
              },
              notify: () => {}
            })
          } finally {
            closed = true
          }
        }
      })
      const record = floatingCodexChat('failed', '/work')
      catalog.read(record)
      await catalog.settled(record, 1_000)
      expect(sleep).toHaveBeenCalledWith(70_000)
      expect(closed).toBe(false)
      floor.resolve()
      await vi.waitFor(() => expect(closed).toBe(true))
    }
  )
})
