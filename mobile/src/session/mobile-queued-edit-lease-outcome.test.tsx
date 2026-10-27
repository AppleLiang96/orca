import { act } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { queuedEditHost } from '../../../src/shared/queued-edit-host.test-fixture'
import type { AgentSessionQueuedMessageEditHoldResult } from '../../../src/shared/agent-session-wire'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { mobileQueuedEditHarness, readOrHoldReply } from './mobile-queued-edit-hook.test-support'
import {
  fieldsOf,
  mutationOk,
  ok,
  queuedDraft,
  SESSION_ID
} from './use-mobile-structured-agent-session-queued.test-fixture'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('mobile current acquisition belongs to the Save outcome owner', () => {
  const { state, mount, sendRequest, notice, append, resolved } = mobileQueuedEditHarness()
  it.each([
    'updated',
    'unchanged',
    'newer',
    'fresh-loss',
    'gone',
    'refused',
    'unknown',
    'late-unknown',
    'unresolved',
    'depart',
    'depart-equal'
  ] as const)(
    '%s does not return accepted current input before the delayed result',
    async (mode) => {
      const message = queuedDraft({ messageId: 'lease-race' })
      const host = queuedEditHost(SESSION_ID, message)
      await mount(message)
      act(() => state.hook!.queued.editor!.cancel())
      const loss = deferred<AgentSessionQueuedMessageEditHoldResult>()
      const freshLoss = deferred<AgentSessionQueuedMessageEditHoldResult>()
      const release = deferred<void>()
      let expected = ''
      let editId = ''
      let acquires = 0
      sendRequest.mockImplementation(async (method, params) => {
        const fields = fieldsOf(params)
        if (method === 'agentSession.queuedMessageEditHold' && fields.action === 'acquire') {
          acquires++
          expected = String(fields.expectedBodyFingerprint)
          editId = String(fields.editId)
          return ok(
            acquires === 1
              ? await loss.promise
              : mode === 'fresh-loss'
                ? await freshLoss.promise
                : host.acquire(editId, expected)
          )
        }
        if (method !== 'agentSession.queuedMessageUpdate') {
          return readOrHoldReply(method, params)
        }
        await release.promise
        if (mode === 'unknown' || mode === 'late-unknown') {
          throw markRpcDeliveryUnknown(new Error('lost'))
        }
        return mutationOk(
          mode === 'refused' ? { status: 'not-editable', messageId: message.messageId } : decision
        )
      })
      await act(async () => {
        await state.hook!.queued.edit!(message.messageId)
      })
      act(() => state.hook!.queued.editor!.change('B'))
      if (mode === 'unchanged') {
        host.update({
          messageId: message.messageId,
          expectedBodyFingerprint: host.row!.fingerprint,
          text: 'B'
        })
      }
      let save!: Promise<boolean>
      act(() => {
        save = state.hook!.queued.editor!.save()
      })
      const decision = host.update({
        messageId: message.messageId,
        expectedBodyFingerprint: expected,
        text: 'B'
      })
      expect(decision.status).toBe(mode === 'unchanged' ? 'unchanged' : 'updated')
      if (mode === 'newer' || mode === 'fresh-loss' || mode === 'gone' || mode === 'depart') {
        act(() => state.hook!.queued.editor!.insertDictation!('C'))
      }
      if (mode === 'gone') {
        host.depart()
      }
      const negative = host.acquire(editId, expected)
      expect(negative.status).toBe(mode === 'gone' ? 'gone' : 'changed')
      if (mode === 'depart' || mode === 'depart-equal') {
        act(() => state.renderer!.unmount())
        state.renderer = undefined
      }
      if (mode !== 'late-unknown' && mode !== 'unresolved') {
        await act(async () => loss.resolve(negative))
        if (mode !== 'depart' && mode !== 'depart-equal') {
          expect(state.hook!.queued.editor?.saving).toBe(true)
        }
        expect(append).not.toHaveBeenCalled()
        expect(notice).not.toHaveBeenCalled()
      }
      await act(async () => {
        release.resolve()
        await save
      })
      if (mode === 'late-unknown') {
        expect(state.hook!.queued.editor).toMatchObject({ saving: false })
        await act(async () => loss.resolve(negative))
      }
      if (mode === 'newer' || mode === 'fresh-loss') {
        expect(state.hook!.queued.editor).toMatchObject({ text: 'B C', saving: false })
        expect(append).not.toHaveBeenCalled()
        expect(acquires).toBe(2)
        expect(resolved).not.toHaveBeenCalled()
        if (mode === 'fresh-loss') {
          host.depart()
          await act(async () => freshLoss.resolve(host.acquire(editId, expected)))
          expect(state.hook!.queued.editor).toBeUndefined()
          expect(append).toHaveBeenCalledWith('B C')
          expect(notice).toHaveBeenCalledOnce()
        } else {
          act(() => state.hook!.queued.editor!.cancel())
          expect(state.bottomText).toBe('')
        }
      } else if (
        mode === 'gone' ||
        mode === 'refused' ||
        mode === 'unknown' ||
        mode === 'late-unknown' ||
        mode === 'depart'
      ) {
        if (mode !== 'depart' && mode !== 'depart-equal') {
          expect(state.hook!.queued.editor).toBeUndefined()
        }
        expect(append).toHaveBeenCalledOnce()
        expect(append).toHaveBeenCalledWith(mode === 'gone' || mode === 'depart' ? 'B C' : 'B')
        expect(notice).toHaveBeenCalledOnce()
      } else {
        if (mode !== 'depart-equal') {
          expect(state.hook!.queued.editor).toBeUndefined()
        }
        expect(append).not.toHaveBeenCalled()
        expect(notice).not.toHaveBeenCalled()
        if (mode !== 'depart-equal') {
          expect(resolved).toHaveBeenCalledOnce()
        }
      }
      if (mode === 'unresolved') {
        await act(async () => loss.resolve(negative))
      }
      expect(append).toHaveBeenCalledTimes(
        ['gone', 'refused', 'unknown', 'late-unknown', 'depart', 'fresh-loss'].includes(mode)
          ? 1
          : 0
      )
      host.leases.dispose()
    }
  )
})
