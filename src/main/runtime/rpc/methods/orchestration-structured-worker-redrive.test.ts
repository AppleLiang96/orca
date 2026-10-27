import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session-journal-types'
import * as historyPages from '../../../native-chat/agent-session-wire/agent-session-history-page'
import * as subscriberFrames from '../../../native-chat/agent-session-wire/agent-session-subscriber-frame-fields'
import { hostTestState } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { createTestParams } from '../../../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import {
  hostTestAttachParams,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredWorkerIdentities } from '../../structured-worker-identity'
import { createOrchestrationRpcHarness } from './orchestration/rpc-test-harness'
import {
  createStructuredWorkerSession,
  releaseStructuredWorkerSession
} from './orchestration-structured-worker-session'
import { stopStructuredWorker } from './orchestration-structured-worker-lifecycle'

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async (args: { envelope: { sessionId: string } }) => {
    const { host } = hostTestState()
    return host.create(
      { callerKey: 'redrive-test' },
      createTestParams(undefined, {
        envelope: {
          ...args.envelope,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: null,
          payloadFingerprint: '0'.repeat(64)
        }
      })
    )
  }
}))

const harness = createOrchestrationRpcHarness()
let state: ReturnType<typeof harness.setup>
let dispatchId: string

beforeEach(() => {
  vi.useFakeTimers()
  structuredWorkerIdentities.clear()
  state = harness.setup()
  vi.spyOn(state.runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined as never)
  const { host, store, acquire } = hostTestState()
  const acquireImpl = acquire.getMockImplementation()
  if (!acquireImpl) {
    throw new Error('Fixture acquisition is missing')
  }
  acquire.mockImplementation(async (input) => {
    const acquired = await acquireImpl(input)
    if (!acquired.link) {
      throw new Error('Fixture acquisition has no provider link')
    }
    return {
      ...acquired,
      link: {
        ...acquired.link,
        origin: store.getRecord(input.identity.sessionId)?.providerHandleChain.length
          ? 'resumed'
          : 'created'
      }
    }
  })
  setStructuredAgentSessionHost(host)
  const task = state.db.createTask({ spec: 'redrive test' })
  dispatchId = state.db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId: task.id,
    startOptions: {}
  }).dispatch.id
})

afterEach(() => {
  releaseStructuredWorkerSession(dispatchId, state.runtime)
  vi.useRealTimers()
  harness.cleanup()
  setStructuredAgentSessionHost(null)
  structuredWorkerIdentities.clear()
  vi.restoreAllMocks()
})

async function startWorker(onJournalActivity = vi.fn<(sessionId: string) => void>()) {
  const { host, store } = hostTestState()
  const { identity } = await createStructuredWorkerSession({
    runtime: state.runtime,
    worktreeId: 'workspace-1',
    agent: 'codex',
    dispatchId,
    onJournalActivity
  })
  const session = host.collaboratorsForTests().sessions.get(identity.sessionId)
  if (!session) {
    throw new Error('Worker did not open its journal')
  }
  const append = async (id: string) => {
    await host
      .collaboratorsForTests()
      .sessions.get(identity.sessionId)!
      .journal.appendItem(
        { provider: 'orca', clientMessageId: id },
        { kind: 'status', text: id },
        {
          fence: store.requireWritableRecord(identity.sessionId).lease.runtimeFence,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      )
  }
  return {
    host,
    identity,
    journal: session.journal,
    fence: store.requireWritableRecord(identity.sessionId).lease.runtimeFence,
    append,
    onJournalActivity
  }
}

async function reattach(sessionId: string) {
  const { host, store } = hostTestState()
  const result = await host.attach(
    { callerKey: 'redrive-test' },
    hostTestAttachParams(store.requireWritableRecord(sessionId).lease.runtimeFence, {
      envelope: {
        sessionId,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: store.requireWritableRecord(sessionId).lease.runtimeFence,
        payloadFingerprint: '0'.repeat(64)
      }
    })
  )
  expect(result.ok).toBe(true)
}

describe('the structured redrive publication edge', () => {
  it('coalesces real commits without client frames, history, commands, queue or roster reads', async () => {
    const { host } = hostTestState()
    const readCatalog = vi.fn(() => undefined)
    let catalogChanged = () => {}
    host.deps.adapter.atRestCommands = {
      read: readCatalog,
      onChange: (listener) => {
        catalogChanged = listener
        return () => {}
      }
    }
    host['clientDelivery'].watchAtRestCommands(host.deps.adapter)
    const worker = await startWorker()
    const hooks = host.collaboratorsForTests().subscribers['hooks']
    const reads = [
      vi.spyOn(historyPages, 'readAgentSessionHistory'),
      vi.spyOn(historyPages, 'readAgentSessionHydrationPage'),
      vi.spyOn(subscriberFrames, 'emitSubscriberFrame'),
      vi.spyOn(hooks, 'readCommands'),
      vi.spyOn(hooks, 'readQueuePublication'),
      vi.spyOn(hooks, 'readBackgroundTasks')
    ]

    for (let batch = 0; batch < 25; batch += 1) {
      await worker.append(`batch-${batch}`)
      catalogChanged()
      vi.advanceTimersByTime(10)
    }
    expect(worker.onJournalActivity).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(worker.onJournalActivity).toHaveBeenCalledExactlyOnceWith(worker.identity.sessionId)
    expect(
      host.collaboratorsForTests().subscribers.subscriberCountForTests(worker.identity.sessionId)
    ).toBe(0)
    expect(readCatalog).not.toHaveBeenCalled()
    for (const read of reads) {
      expect(read).not.toHaveBeenCalled()
    }
  })

  it('wakes after a tombstone settles the running turn', async () => {
    const { identity, journal, fence, onJournalActivity } = await startWorker()
    const turn = { provider: 'orca', clientMessageId: 'running-turn' } as const
    await journal.appendItem(
      turn,
      { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    vi.advanceTimersByTime(300)
    onJournalActivity.mockClear()

    await journal.appendTombstone(turn, { fence })
    vi.advanceTimersByTime(300)

    expect(onJournalActivity).toHaveBeenCalledExactlyOnceWith(identity.sessionId)
    expect(journal.snapshot().items).toEqual([])
  })

  it('still re-evaluates a journal that never goes quiet', async () => {
    const { append, onJournalActivity } = await startWorker()
    for (let batch = 0; batch < 60; batch += 1) {
      await append(`batch-${batch}`)
      vi.advanceTimersByTime(100)
    }
    expect(onJournalActivity.mock.calls.length).toBeGreaterThan(0)
    expect(onJournalActivity.mock.calls.length).toBeLessThan(10)
  })

  it('wakes on the journal rollover that resets client cursors', async () => {
    const { identity, journal, fence, onJournalActivity } = await startWorker()
    const before = journal.cursor()

    await journal.rollEpoch('unreconcilable_prefix', fence)
    vi.advanceTimersByTime(300)

    expect(journal.cursor().epoch).not.toBe(before.epoch)
    expect(onJournalActivity).toHaveBeenCalledExactlyOnceWith(identity.sessionId)
  })

  it('keeps the observer across close and reattach with a new fence', async () => {
    const { host, identity, onJournalActivity } = await startWorker()
    await reattach(identity.sessionId)
    const snapshot = vi.spyOn(host.collaboratorsForTests().subscribers, 'snapshot')
    await host.close(identity.sessionId, 'evict')
    await host.journalSnapshot(identity.sessionId)
    vi.advanceTimersByTime(300)
    onJournalActivity.mockClear()

    await reattach(identity.sessionId)
    vi.advanceTimersByTime(300)

    expect(snapshot).toHaveBeenCalled()
    expect(onJournalActivity).toHaveBeenCalledExactlyOnceWith(identity.sessionId)
  })

  it('wakes on row-free generation end without renewing idle activity', async () => {
    const { host, identity, journal, onJournalActivity } = await startWorker()
    const sessions = host.collaboratorsForTests().sessions
    const before = {
      cursor: journal.cursor(),
      activity: sessions.lastActivityAt(identity.sessionId)
    }
    vi.advanceTimersByTime(1_000)

    host.publishWorkChanged(identity.sessionId)
    vi.advanceTimersByTime(300)

    expect(onJournalActivity).toHaveBeenCalledExactlyOnceWith(identity.sessionId)
    expect(journal.cursor()).toEqual(before.cursor)
    expect(sessions.lastActivityAt(identity.sessionId)).toBe(before.activity)
  })

  it.each(['release', 'stop', 'abandon'] as const)(
    '%s disposes the observer and cancels pending wakes',
    async (action) => {
      const { host } = hostTestState()
      const observe = host.observeJournalPublications
      const disposed = vi.fn()
      vi.spyOn(host, 'observeJournalPublications').mockImplementation((id, listener) => {
        const dispose = observe(id, listener)
        return () => {
          disposed()
          dispose()
        }
      })
      const { identity, append, onJournalActivity } = await startWorker()
      await append('before-release')

      if (action === 'release') {
        releaseStructuredWorkerSession(dispatchId, state.runtime)
      } else if (action === 'stop') {
        await stopStructuredWorker(identity, dispatchId, state.runtime)
      } else {
        await harness.call('orchestration.workerAbandon', { dispatch: dispatchId }, state.ctx)
      }

      expect(disposed).toHaveBeenCalledTimes(1)
      // A publication after teardown must not re-arm the disposed coalescer.
      if (action === 'stop') {
        await reattach(identity.sessionId)
      }
      await append('after-release')
      vi.advanceTimersByTime(5_000)
      expect(onJournalActivity).not.toHaveBeenCalled()
    }
  )
})
