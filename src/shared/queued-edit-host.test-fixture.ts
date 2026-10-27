import { QueuedMessageEditLeases } from '../main/native-chat/agent-session-journal/queued-message-edit-leases'
import {
  queuedMessageUpdateDecision,
  type QueuedMessageUpdate
} from '../main/native-chat/agent-session-journal/queued-message-update'
import type { QueuedMessageRow } from '../main/native-chat/agent-session-journal/queued-message-table'
import type { AgentSessionQueuedMessage } from './agent-session-wire'
import { agentSessionSendBodyFingerprint } from './structured-agent-session-send-mutation'

/** Real CAS/lease decisions; delivery of their answers is controlled by the client harness. */
export function queuedEditHost(sessionId: string, message: AgentSessionQueuedMessage) {
  let row: QueuedMessageRow | null = {
    ...message,
    fingerprint: agentSessionSendBodyFingerprint(sessionId, message.body),
    holdReason: null,
    returnedReason: null,
    returnedRejection: null,
    consumedAs: null,
    queuedAt: null
  }
  const leases = new QueuedMessageEditLeases(() => (row ? [row] : []))
  const update = (input: QueuedMessageUpdate) => {
    const result = queuedMessageUpdateDecision(row, sessionId, input)
    if (result.status !== 'ready') {
      return result
    }
    if (!row) {
      throw new Error('missing row')
    }
    row = { ...row, body: result.body, fingerprint: result.fingerprint }
    leases.retire(message.messageId)
    return {
      status: 'updated' as const,
      messageId: message.messageId,
      fingerprint: result.fingerprint
    }
  }
  return {
    leases,
    update,
    get row() {
      return row
    },
    depart: () => {
      row = null
    },
    acquire: (editId: string, expected: string) =>
      leases.acquire(
        { callerKey: 'client', editId },
        { messageId: message.messageId, fingerprint: expected }
      )
  }
}
