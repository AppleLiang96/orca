import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionSlashCommand } from '../../../shared/agent-session-wire'
import { requireLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { agentSessionPinnedLaunchDirectory } from '../../runtime/agent-session-record-launch-directory'
import type { StructuredAgentSessionAtRestCommands } from './structured-agent-session-at-rest-commands'
import { atRestCommandContextReady } from './at-rest-command-context'

/** Running chats supply their own lists; rescan resting folders/accounts after this TTL. */
export const AT_REST_COMMANDS_TTL_MS = 5 * 60_000
/** Retry failures before the full TTL can hide commands, but only a few times: a folder that never answers would rescan forever. */
const FAILED_SCAN_RETRY_MS = 10_000
const MAX_FAILED_SCANS = 3
/** Long past any TTL, so a shown chat never loses its list to eviction between reads. */
const EVICT_UNREAD_MS = 60 * 60_000
/** Phones read once per menu; finish within their request timeout. */
export const AT_REST_COMMANDS_READ_BUDGET_MS = 10_000

/** Fallbacks never replace agent-provided lists; undefined means no provider list. */
export type AtRestCommandScan = {
  commands: AgentSessionSlashCommand[] | undefined
  fromAgent: boolean
}

export type AtRestCommandSource = {
  /** Other hosts must scan their own folders. */
  accepts: (record: AgentSessionRecord) => boolean
  /** Each source bounds its own work; the catalog never starts a second scan for a key. */
  scan: (
    record: AgentSessionRecord,
    cwd: string,
    isCurrent: () => boolean,
    /** Grows on every retire; sources that cache provider answers reload for a newer one. */
    generation: number
  ) => Promise<AtRestCommandScan>
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  label: string
  now?: () => number
}

type Entry = {
  key: string
  workspaceId: string
  generation: number
  commands?: AgentSessionSlashCommand[]
  fromAgent?: boolean
  /** Failures age the retained answer for earlier retry. */
  scannedAt: number
  failures: number
  scanning: boolean
  lastReadAt: number
  settled: Set<() => void>
}

/** Cache commands from each resting chat’s launch folder; publish changed scan results. */
export class AtRestCommandCatalog implements StructuredAgentSessionAtRestCommands {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private nextEviction = Number.NEGATIVE_INFINITY
  private disposed = false

  constructor(private readonly source: AtRestCommandSource) {}

  retireContext = (workspaceId?: string): void => {
    this.generation += 1
    for (const [key, entry] of this.entries) {
      if (workspaceId !== undefined && entry.workspaceId !== workspaceId) {
        continue
      }
      this.entries.delete(key)
      entry.settled.forEach((done) => done())
    }
    queueMicrotask(() => {
      if (!this.disposed) {
        this.listeners.forEach((listener) => listener())
      }
    })
  }

  dispose = (): void => {
    this.disposed = true
    this.retireContext()
    this.listeners.clear()
  }

  read = (record: AgentSessionRecord): AgentSessionSlashCommand[] | undefined =>
    this.readEntry(record)?.commands

  settled = async (record: AgentSessionRecord, budgetMs: number) => {
    const deadline = Date.now() + budgetMs
    for (;;) {
      const entry = this.readEntry(record)
      if (!entry) {
        return undefined
      }
      const remaining = deadline - Date.now()
      if (entry.scanning && remaining > 0) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer)
            entry.settled.delete(done)
            resolve()
          }
          const timer = setTimeout(done, remaining)
          entry.settled.add(done)
        })
      }
      if (this.entries.get(entry.key) === entry) {
        return entry.commands
      }
      if (this.disposed || Date.now() >= deadline) {
        return undefined
      }
    }
  }

  onChange = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // Folder pins and accounts can expose different skills.
  private readEntry(record: AgentSessionRecord): Entry | undefined {
    if (this.disposed || !this.source.accepts(record)) {
      return undefined
    }
    const now = this.now()
    const key = JSON.stringify([
      record.provider,
      requireLegacyAgentSessionAccountHome(record.accountHome).path,
      record.location.workspaceId,
      agentSessionPinnedLaunchDirectory(record)
    ])
    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        key,
        workspaceId: record.location.workspaceId,
        generation: this.generation,
        scannedAt: Number.NEGATIVE_INFINITY,
        failures: 0,
        scanning: false,
        lastReadAt: now,
        settled: new Set()
      }
      this.entries.set(key, entry)
    }
    entry.lastReadAt = now
    this.evictUnread(now)
    // Readers join the running scan; a slow source must not multiply its own work.
    if (!entry.scanning && now - entry.scannedAt >= AT_REST_COMMANDS_TTL_MS) {
      this.scanInto(entry, record)
    }
    return entry
  }

  /** Released and closed chats stop being read; drop their entries instead of keeping them forever. */
  private evictUnread(now: number): void {
    if (now < this.nextEviction) {
      return
    }
    this.nextEviction = now + AT_REST_COMMANDS_TTL_MS
    for (const [key, entry] of this.entries) {
      if (!entry.scanning && now - entry.lastReadAt >= EVICT_UNREAD_MS) {
        this.entries.delete(key)
      }
    }
  }

  private scanInto(entry: Entry, record: AgentSessionRecord): void {
    const isCurrent = (): boolean => !this.disposed && this.entries.get(entry.key) === entry
    entry.scanning = true
    void (async () => {
      await atRestCommandContextReady()
      const cwd =
        agentSessionPinnedLaunchDirectory(record) ??
        (await this.source.resolveWorkspacePath(record.location.workspaceId))
      return isCurrent()
        ? this.source.scan(record, cwd, isCurrent, entry.generation)
        : { commands: undefined, fromAgent: false }
    })()
      .then(
        ({ commands, fromAgent }) => {
          if (!isCurrent()) {
            return
          }
          entry.scannedAt = this.now()
          entry.failures = 0
          // Refresh settles even when fallback cannot supersede an agent-provided list.
          if (entry.fromAgent && !fromAgent) {
            return
          }
          entry.fromAgent = fromAgent
          if (JSON.stringify(commands) === JSON.stringify(entry.commands)) {
            return
          }
          entry.commands = commands
          for (const listener of this.listeners) {
            listener()
          }
        },
        (error: unknown) => {
          if (!isCurrent()) {
            return
          }
          entry.failures += 1
          entry.scannedAt =
            entry.failures < MAX_FAILED_SCANS
              ? this.now() - AT_REST_COMMANDS_TTL_MS + FAILED_SCAN_RETRY_MS
              : this.now()
          console.warn(`[${this.source.label}] reading the at-rest \`/\` commands failed:`, error)
        }
      )
      .finally(() => {
        entry.scanning = false
        entry.settled.forEach((done) => done())
      })
  }

  private now(): number {
    return this.source.now?.() ?? Date.now()
  }
}
