import { QueuedMessageUpdateParams } from '../../../src/shared/rpc-contract/structured-agent-session-queued-edit-params'
import { useMobileNativeChatComposerMenu } from './native-chat/composer/use-mobile-native-chat-composer-menu'
import {
  resetMobileNativeChatDraftStoreForTests,
  useMobileNativeChatDraft
} from './native-chat/composer/mobile-native-chat-draft-store'
import {
  updateMobileNativeChatDraftInputs,
  resetMobileNativeChatDraftInputsForTests
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, vi } from 'vitest'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageEditHoldResult
} from '../../../src/shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import { queuedMessageWithEdit } from '../../../src/shared/queued-message-edit'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import {
  CAPABLE,
  SESSION_ID,
  fieldsOf,
  mutationOk,
  ok,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'

export function withText(body: AgentSessionQueuedMessage['body'], text: string) {
  const edited = queuedMessageWithEdit(body, { text })
  if (!edited.ok) {
    throw new Error(edited.reason)
  }
  return edited.body
}

export function editHoldReply(params: unknown): RpcResponse {
  const result: AgentSessionQueuedMessageEditHoldResult =
    fieldsOf(params).action === 'release'
      ? { status: 'released' }
      : { status: 'held', fingerprint: 'fp', leaseDurationMs: 120_000, remainingMs: 120_000 }
  return ok(result)
}

export function readOrHoldReply(method: string, params: unknown): RpcResponse {
  return method === 'agentSession.queuedMessageEditHold'
    ? editHoldReply(params)
    : ok({ models: [], current: {} })
}

vi.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('lucide-react-native', () => ({
  FileText: 'FileText',
  Package: 'Package',
  Terminal: 'Terminal'
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))

export function mobileQueuedEditHarness() {
  const state: {
    renderer?: ReactTestRenderer
    bottomText: string
    hook?: ReturnType<typeof useMobileStructuredAgentSession>
    menu?: ReturnType<typeof useMobileNativeChatComposerMenu>
    listener?: (data: unknown) => void
  } = { bottomText: '' }
  const append = vi.fn(() => true)
  const error = vi.fn()
  const notice = vi.fn()
  const resolved = vi.fn()
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const client: RpcClient = {
    sendRequest,
    subscribe: (_method, _params, onData) => {
      state.listener = onData
      return () => {}
    },
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  function Harness({
    sessionId = SESSION_ID,
    editSupport = true,
    enabled = true,
    connected = true,
    transport = client,
    composerScopeKey,
    imagesSupport = false,
    skillsSupport = false
  }: {
    sessionId?: string
    editSupport?: boolean | null
    enabled?: boolean
    connected?: boolean
    transport?: RpcClient | null
    composerScopeKey?: string
    imagesSupport?: boolean
    skillsSupport?: boolean
  }): null {
    state.bottomText = useMobileNativeChatDraft('original-bottom')
    state.hook = useMobileStructuredAgentSession({
      client: transport,
      sessionId,
      sourceIdentity: 'host-a',
      enabled,
      connected,
      agent: 'codex',
      hostSupport:
        editSupport === null
          ? null
          : {
              ...CAPABLE,
              queuedMessages: false,
              queuedMessageImageEdit: imagesSupport,
              queuedMessageSkillsEdit: skillsSupport,
              queuedMessageEdit: editSupport
            },
      composerScopeKey,
      appendComposerText: append,
      onSendError: error,
      onQueuedEditNotice: notice,
      onActionResolved: resolved
    })
    state.menu = useMobileNativeChatComposerMenu({
      value: state.hook.queued.editor?.text ?? '',
      onChangeText: (text) => state.hook?.queued.editor?.change(text),
      agent: 'codex',
      structuredCatalog: {
        reported: [{ name: 'review', kind: 'skill', path: '/B/SKILL.md' }],
        conversationCommands: []
      },
      filePaths: [],
      focusField: () => {},
      editing: true,
      onPickSkill: (skill) => {
        const key = state.hook?.queued.editor?.scopeKey
        if (key) {
          updateMobileNativeChatDraftInputs(key, (before) => ({ ...before, skills: [skill] }))
        }
      }
    })
    return null
  }
  function requestedFingerprint(message: AgentSessionQueuedMessage) {
    const params = sendRequest.mock.calls.findLast(
      ([method]) => method === 'agentSession.queuedMessageUpdate'
    )?.[1]
    const fields = QueuedMessageUpdateParams.parse(params)
    const edited = queuedMessageWithEdit(message.body, fields)
    if (!edited.ok) {
      throw new Error(edited.reason)
    }
    return agentSessionSendBodyFingerprint(SESSION_ID, edited.body)
  }
  async function mount(message: AgentSessionQueuedMessage, editSupport: boolean | null = true) {
    vi.clearAllMocks()
    resetMobileNativeChatDraftInputsForTests()
    resetMobileNativeChatDraftStoreForTests()
    sendRequest.mockImplementation(async (method, params) =>
      method === 'agentSession.queuedMessageUpdate'
        ? mutationOk({
            status: 'updated',
            messageId: message.messageId,
            fingerprint: requestedFingerprint(message)
          })
        : readOrHoldReply(method, params)
    )
    await act(async () => {
      state.renderer = create(createElement(Harness, { editSupport }))
    })
    act(() => state.listener?.(snapshotEvent({ queuedMessages: [message], runningTurn: true })))
    if (editSupport !== null) {
      await act(async () => {
        expect(await state.hook!.queued.edit!(message.messageId)).toBe(true)
      })
    }
  }
  afterEach(async () => {
    await act(async () => state.renderer?.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  return {
    state,
    Harness,
    mount,
    client,
    sendRequest,
    append,
    error,
    notice,
    resolved,
    requestedFingerprint
  }
}
