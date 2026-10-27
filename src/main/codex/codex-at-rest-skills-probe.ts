import { createHash } from 'node:crypto'
import { PrioritySemaphore } from '../../shared/priority-semaphore'
import {
  isLegacyAgentSessionAccountHome,
  requireLegacyAgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import { codexStructuredLaunchArgs } from './codex-structured-launch-args'
import {
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV,
  NATIVE_CHAT_SCRATCH_DIR_ENV
} from '../native-chat/native-chat-visuals-delivery'
import {
  AtRestCommandCatalog,
  type AtRestCommandScan
} from '../native-chat/agent-session-wire/at-rest-command-catalog'
import { runCodexAppServerSession, type CodexAppServerRpc } from './codex-app-server-session'
import {
  CODEX_SKILLS_LIST_METHOD,
  codexFolderSkillReport,
  codexSkillRows,
  codexReportCommandRows,
  isCodexSkillsListUnsupported
} from './codex-skill-list'
import { supportsCodexStructuredLocation } from './codex-structured-location-support'
import { resolveHiddenProbeCwd } from '../rate-limits/hidden-probe-cwd'
import {
  resolveCodexStructuredInvocation,
  type CodexStructuredInvocationDeps
} from './codex-structured-launch-resolution'

const ANSWER_TIMEOUT_MS = 15_000
/** Startup grace for plugin sync; longer sync can still be interrupted and retain staging. */
export const CODEX_SKILLS_PROBE_SETTLE_MS = 70_000
/** Probe processes alive at once, counted until teardown ends; one answers every folder of its launch. */
const MAX_PROBE_PROCESSES = 2
/** Codex loads each folder's config; keep one request inside its answer timeout. */
const MAX_FOLDERS_PER_REQUEST = 8
/** Covers a full probe life ahead in line plus this folder's own answer. */
const FOLDER_DEADLINE_MS = CODEX_SKILLS_PROBE_SETTLE_MS + 2 * ANSWER_TIMEOUT_MS
/** A probe that fails to start backs off; retiring answers must not reset this. */
const FAILED_START_BACKOFF_MS = [10_000, 30_000, 90_000, 5 * 60_000] as const

export type CodexAtRestSkillsDeps = CodexStructuredInvocationDeps & {
  resolveLaunchArgs: () => Promise<string[]> | string[]
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  /** Apply launch-time home sync so the probe sees the same configuration. */
  prepareHome?: (home: string) => void
  now?: () => number
  runSession?: typeof runCodexAppServerSession
  sleep?: (ms: number) => Promise<void>
}

type FolderRequest = {
  cwd: string
  generation: number
  isCurrent: () => boolean
  answer: PromiseWithResolvers<AtRestCommandScan>
  timer: ReturnType<typeof setTimeout>
  done: boolean
}

/** One launch identity: the same account, binary, arguments and environment answer alike. */
type ProbePool = {
  key: string
  accountHomePath: string
  command: string
  args: string[]
  environment: Record<string, string>
  waiting: FolderRequest[]
  /** Queued for a process slot, alive, or tearing down. */
  running: boolean
  wake?: () => void
  failedStarts: number
  retryAt: number
}

const NO_SCAN: AtRestCommandScan = { commands: undefined, fromAgent: false }

function definedEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) {
      next[key] = value
    }
  }
  return next
}

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

function settle(request: FolderRequest, outcome: AtRestCommandScan | Error): void {
  if (request.done) {
    return
  }
  request.done = true
  clearTimeout(request.timer)
  if (outcome instanceof Error) {
    request.answer.reject(outcome)
  } else {
    request.answer.resolve(outcome)
  }
}

/** Reports launch-folder skills before plugin startup grace expires; sync may still be unfinished. */
export function createCodexAtRestSkillCatalog(deps: CodexAtRestSkillsDeps): AtRestCommandCatalog {
  const now = deps.now ?? Date.now
  const processes = new PrioritySemaphore(MAX_PROBE_PROCESSES)
  const pools = new Map<string, ProbePool>()

  const run = async (pool: ProbePool): Promise<void> => {
    pool.running = true
    const release = await processes.acquire(0)
    let started = false
    try {
      // A folder that timed out or was retired while queued never starts a process.
      dropStale(pool)
      if (pool.waiting.length === 0) {
        return
      }
      deps.prepareHome?.(pool.accountHomePath)
      await probe(deps, pool, now(), () => {
        started = true
        pool.failedStarts = 0
      })
    } catch (error) {
      if (!started) {
        pool.failedStarts += 1
        pool.retryAt =
          now() +
          FAILED_START_BACKOFF_MS[Math.min(pool.failedStarts, FAILED_START_BACKOFF_MS.length) - 1]
      }
      const failure = error instanceof Error ? error : new Error(String(error))
      pool.waiting.splice(0).forEach((request) => settle(request, failure))
    } finally {
      pool.wake = undefined
      release()
      pool.running = false
      if (pool.waiting.length > 0) {
        void run(pool)
      } else if (pool.failedStarts === 0) {
        pools.delete(pool.key)
      }
    }
  }

  return new AtRestCommandCatalog({
    label: 'codex',
    accepts: (record) =>
      record.provider === 'codex' &&
      supportsCodexStructuredLocation(record.location) &&
      isLegacyAgentSessionAccountHome(record.accountHome),
    resolveWorkspacePath: deps.resolveWorkspacePath,
    scan: async (record, cwd, isCurrent, generation) => {
      const accountHomePath = requireLegacyAgentSessionAccountHome(record.accountHome).path
      const { command, environment } = await resolveCodexStructuredInvocation({
        ...deps,
        resolveWorkingDirectory: () => cwd
      })
      const args = codexStructuredLaunchArgs(await deps.resolveLaunchArgs())
      if (!isCurrent()) {
        return NO_SCAN
      }
      const env = definedEnv(environment)
      const key = JSON.stringify([
        accountHomePath,
        command,
        args,
        createHash('sha256')
          .update(JSON.stringify(Object.entries(env).sort()))
          .digest('hex')
      ])
      const pool = pools.get(key) ?? {
        key,
        accountHomePath,
        command,
        args,
        environment: env,
        waiting: [],
        running: false,
        failedStarts: 0,
        retryAt: 0
      }
      pools.set(key, pool)
      if (!pool.running && now() < pool.retryAt) {
        throw new Error('codex app-server could not start recently; waiting before trying again')
      }
      const request: FolderRequest = {
        cwd,
        generation,
        isCurrent,
        answer: Promise.withResolvers<AtRestCommandScan>(),
        timer: setTimeout(() => {
          const index = pool.waiting.indexOf(request)
          if (index !== -1) {
            pool.waiting.splice(index, 1)
          }
          settle(request, new Error(`codex did not list skills for ${cwd} in time`))
        }, FOLDER_DEADLINE_MS),
        done: false
      }
      pool.waiting.push(request)
      pool.wake?.()
      if (!pool.running) {
        void run(pool)
      }
      return request.answer.promise
    },
    ...(deps.now ? { now: deps.now } : {})
  })
}

function dropStale(pool: ProbePool): void {
  pool.waiting = pool.waiting.filter((request) => {
    if (request.done) {
      return false
    }
    if (!request.isCurrent()) {
      settle(request, NO_SCAN)
      return false
    }
    return true
  })
}

/** One process answers its launch's folders until the startup grace ends, then the tree is torn down. */
async function probe(
  deps: CodexAtRestSkillsDeps,
  pool: ProbePool,
  spawnedAt: number,
  onStarted: () => void
): Promise<void> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? sleepFor
  // A new process has no cached skills, so it already reflects every retire so far.
  let reloaded = Math.max(...pool.waiting.map((request) => request.generation))
  await (deps.runSession ?? runCodexAppServerSession)(
    {
      command: pool.command,
      args: [...pool.args, 'app-server'],
      // skills/list takes the folder per request; a settling probe in it blocks Windows worktree removal (#33174).
      cwd: resolveHiddenProbeCwd(),
      cliPath: pool.command,
      env: { ...pool.environment, CODEX_HOME: pool.accountHomePath },
      envToDelete: [NATIVE_CHAT_SCRATCH_DIR_ENV, LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV],
      // The last request can start just before the grace ends.
      timeoutMs: CODEX_SKILLS_PROBE_SETTLE_MS + 2 * ANSWER_TIMEOUT_MS,
      treeKillOnFinish: true
    },
    async (rpc) => {
      onStarted()
      // Settling holds the process and its slot until the grace ends; a new folder wakes it early.
      const graceEnded = sleep(spawnedAt + CODEX_SKILLS_PROBE_SETTLE_MS - now()).then(() => false)
      let answered = false
      for (;;) {
        const remaining = spawnedAt + CODEX_SKILLS_PROBE_SETTLE_MS - now()
        dropStale(pool)
        if (remaining <= 0 && answered) {
          // Folders arriving now go to the next process.
          return
        }
        const batch = pool.waiting.splice(0, MAX_FOLDERS_PER_REQUEST)
        if (batch.length > 0) {
          const forceReload = batch.some((request) => request.generation > reloaded)
          reloaded = Math.max(reloaded, ...batch.map((request) => request.generation))
          await answer(rpc, batch, forceReload)
          answered = true
          continue
        }
        if (remaining <= 0) {
          return
        }
        const woken = await Promise.race([
          graceEnded,
          new Promise<boolean>((resolve) => {
            pool.wake = () => resolve(true)
          })
        ])
        pool.wake = undefined
        if (!woken) {
          return
        }
      }
    }
  )
}

async function answer(
  rpc: CodexAppServerRpc,
  batch: FolderRequest[],
  forceReload: boolean
): Promise<void> {
  let reply: unknown
  try {
    reply = await rpc.request(
      CODEX_SKILLS_LIST_METHOD,
      { cwds: batch.map((request) => request.cwd), ...(forceReload ? { forceReload: true } : {}) },
      { timeoutMs: ANSWER_TIMEOUT_MS }
    )
  } catch (error) {
    if (isCodexSkillsListUnsupported(error)) {
      // An older Codex has no list to give; the client keeps its folder scan.
      batch.forEach((request) => settle(request, { commands: undefined, fromAgent: true }))
      return
    }
    // The process still settles: ending it early would interrupt plugin sync, including after a list failure.
    batch.forEach((request) =>
      settle(request, error instanceof Error ? error : new Error(String(error)))
    )
    return
  }
  for (const request of batch) {
    const commands =
      codexFolderSkillReport(reply, request.cwd) ??
      // Older replies may name a single folder differently.
      (batch.length === 1
        ? [...codexReportCommandRows(), ...codexSkillRows(reply, request.cwd)]
        : undefined)
    settle(
      request,
      commands
        ? { commands, fromAgent: true }
        : new Error(`codex listed no skills entry for ${request.cwd}`)
    )
  }
}
