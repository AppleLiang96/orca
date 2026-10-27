import { QueuedMessageUpdateParams } from '../../../src/shared/rpc-contract/structured-agent-session-queued-edit-params'
import { createElement, type ReactNode } from 'react'
import {
  useMobileNativeChatDraft,
  setMobileNativeChatDraftText
} from './native-chat/composer/mobile-native-chat-draft-store'
import {
  updateMobileNativeChatDraftInputs,
  mobileNativeChatDraftDestination,
  captureMobileNativeChatTextDestination
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import { useMobileNativeChatFileAttachments } from './native-chat/composer/use-mobile-native-chat-file-attachments'
import { useMobileNativeChatImageAttachments } from './native-chat/composer/use-mobile-native-chat-image-attachments'
import { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { mobileQueuedEditHarness, readOrHoldReply } from './mobile-queued-edit-hook.test-support'
import { MobileQueuedMessageComposerContext } from './mobile-queued-message-composer-context'
import { MobileNativeChatQueuedMessages } from './MobileNativeChatQueuedMessages'
import { MobileNativeChatComposer } from './native-chat/composer/MobileNativeChatComposer'
import { MobileNativeChatComposerMenu } from './native-chat/composer/MobileNativeChatComposerMenu'
import { MobileQueuedMessageComposer } from './MobileQueuedMessageComposer'
import { readMobileNativeChatDraftInputs } from './native-chat/composer/mobile-native-chat-draft-inputs'
import { queuedEditHost } from '../../../src/shared/queued-edit-host.test-fixture'
import { queuedMessageWithEdit } from '../../../src/shared/queued-message-edit'
import {
  mutationOk,
  queuedDraft,
  SESSION_ID
} from './use-mobile-structured-agent-session-queued.test-fixture'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'

const picker = vi.hoisted(() => ({ pickFiles: vi.fn(), pickImages: vi.fn() }))
vi.mock('../platform/media-picker', () => ({ useMediaPicker: () => picker }))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('../components/mounted-bottom-drawer', () => ({ MountedBottomDrawer: 'BottomDrawer' }))
vi.mock('../components/bottom-drawer-modal-host-scope', () => ({
  useBottomDrawerModalHost: () => null
}))

describe('real phone inline composer from More through picker pruning and host body', () => {
  const { state, Harness, mount, sendRequest, error, resolved, client } = mobileQueuedEditHarness()
  const profiles = [
    ['claude', 'model', '/model'],
    ['codex', 'review.v2', '$review.v2'],
    ['pi', 'skill:review', '/skill:review'],
    ['openclaude', 'review', '/review'],
    ['opencode', 'review', '/review'],
    ['opencode2', 'review', '/review'],
    ['grok', 'review', '/review']
  ] as const
  async function rows(
    message: Parameters<typeof mount>[0],
    agent = 'codex',
    sessionId = SESSION_ID,
    catalog: { reported: { name: string; kind: 'skill' | 'command'; path?: string }[] } = {
      reported: []
    },
    extra?: (hook: NonNullable<typeof state.hook>) => ReactNode
  ) {
    await mount(message, true, agent, sessionId)
    act(() => state.hook!.queued.editor!.cancel())
    resolved.mockClear()
    const renderContent: NonNullable<Parameters<typeof Harness>[0]['renderContent']> = (hook) =>
      createElement(
        MobileQueuedMessageComposerContext.Provider,
        {
          value: {
            agent,
            structured: {
              catalog: { reported: catalog.reported, conversationCommands: [] },
              onSlashMenuOpen: () => {},
              files: [],
              onRemoveFile: () => {}
            },
            filePaths: [],
            onNeedFiles: undefined,
            onError: error,
            onMicPress: undefined,
            micActive: false,
            dictationMode: undefined,
            onMicPressIn: () => {},
            onMicPressOut: () => {}
          }
        },
        createElement(MobileNativeChatQueuedMessages, {
          cards: hook.queued.cards,
          onEdit: hook.queued.edit,
          editor: hook.queued.editor
        }),
        extra?.(hook)
      )
    const rerender = async () =>
      act(async () =>
        state.renderer!.update(
          createElement(Harness, {
            sessionId,
            agent,
            renderContent,
            skillsSupport: true,
            imagesSupport: true,
            composerScopeKey: 'original-bottom'
          })
        )
      )
    await rerender()
    const root = () => state.renderer!.root
    const button = (label: string) =>
      root().findAll(
        (node) =>
          node.props.accessibilityLabel === label && typeof node.props.onPress === 'function'
      )[0]!
    const field = () =>
      root().find((node) => node.type === 'TextInput' && node.props.multiline === true)
    const open = async () => {
      await act(async () => button('More actions').props.onPress())
      const sheet = root().find(
        (node) =>
          node.type === 'ActionSheetModal' && node.props.actions?.[0]?.label === 'Edit message'
      )
      await act(async () => sheet.props.actions[0].onPress())
      expect(root().findAllByType(MobileQueuedMessageComposer)).toHaveLength(1)
      expect(root().findAllByType(MobileNativeChatComposer)).toHaveLength(extra ? 2 : 1)
    }
    await open()
    return { root, button, field, rerender, open }
  }
  it.each(profiles)(
    '%s retains selected %s through the actual wrapper and accepted body',
    async (agent, name, token) => {
      const message = queuedDraft({
        messageId: 'picked',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'seed' }] }
      })
      const host = queuedEditHost(SESSION_ID, message)
      let path = '/A/SKILL.md'
      let unknown = agent === 'claude'
      let desired = message.body
      const catalog = { reported: [{ name, kind: 'skill' as const, path }] }
      const { button, field, rerender } = await rows(message, agent, SESSION_ID, catalog)
      sendRequest.mockImplementation(async (method, params) => {
        if (method !== 'agentSession.queuedMessageUpdate') {
          return readOrHoldReply(method, params)
        }
        const fields = QueuedMessageUpdateParams.parse(params)
        const edited = queuedMessageWithEdit(host.row!.body, fields)
        if (!edited.ok) {
          throw new Error(edited.reason)
        }
        desired = edited.body
        if (unknown) {
          throw markRpcDeliveryUnknown(new Error('lost'))
        }
        return mutationOk(host.update(fields))
      })
      const pick = async () => {
        act(() => field().props.onChangeText('/'))
        act(() =>
          field().props.onSelectionChange({ nativeEvent: { selection: { start: 1, end: 1 } } })
        )
        await act(async () => button(token).props.onPress())
        expect(state.hook!.queued.editor?.text).toBe(`${token} `)
        expect(readMobileNativeChatDraftInputs(state.hook!.queued.editor!.scopeKey).skills).toEqual(
          [{ name, path }]
        )
      }
      await pick()
      await act(async () => button('Save edited message').props.onPress())
      if (unknown) {
        const first = desired
        path = '/B/SKILL.md'
        catalog.reported = [{ name, kind: 'skill', path }]
        await rerender()
        // Reopen menu after deleting: deletion retires A before picking B.
        act(() => field().props.onChangeText(''))
        await pick()
        act(() => field().props.onChangeText(`${token} suffix`))
        const { batchEvent } =
          await import('./use-mobile-structured-agent-session-queued.test-fixture')
        act(() => state.listener?.(batchEvent([{ ...message, body: first }])))
        expect(state.hook!.queued.editor?.text).toBe(`${token} suffix`)
        expect(resolved).not.toHaveBeenCalled()
        expect(state.bottomText).toBe('')
        host.update({
          messageId: 'picked',
          expectedBodyFingerprint: host.row!.fingerprint,
          text: token,
          images: [],
          skills: [{ name, path: '/A/SKILL.md' }]
        })
        unknown = false
        await act(async () => button('Save edited message').props.onPress())
      }
      expect(error.mock.calls).toEqual([])
      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'agentSession.queuedMessageUpdate')
      ).not.toHaveLength(0)
      expect(state.hook!.queued.editor).toBeUndefined()
      expect(host.row!.body.skills).toEqual([{ name, path }])
      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'agentSession.queuedMessageUpdate')
      ).toHaveLength(agent === 'claude' ? 2 : 1)
      expect(
        sendRequest.mock.calls.some(([method]) =>
          /(?:\.send$|conversationCommand|goal|resume|pty)/i.test(method)
        )
      ).toBe(false)
      host.leases.dispose()
    }
  )
  it('retiring a selected namesake refuses typed and stale command activation through the real wrapper', async () => {
    const message = queuedDraft({ messageId: 'namesake' })
    const { root, button, field } = await rows(message, 'claude', SESSION_ID, {
      reported: [{ name: 'model', kind: 'skill', path: '/A/SKILL.md' }]
    })
    act(() => field().props.onChangeText('/'))
    act(() => field().props.onSelectionChange({ nativeEvent: { selection: { start: 1, end: 1 } } }))
    const stale = root().findByType(MobileNativeChatComposerMenu).props.onPick
    await act(async () => button('/model').props.onPress())
    const key = state.hook!.queued.editor!.scopeKey
    expect(readMobileNativeChatDraftInputs(key).skills).toHaveLength(1)
    act(() => stale({ kind: 'command', token: '/model', name: 'model', id: 'command:model' }))
    expect(error).toHaveBeenLastCalledWith("Commands can't be saved in a queued message.")
    expect(state.hook!.queued.editor!.text).toBe('/model ')
    act(() => field().props.onChangeText(''))
    act(() => field().props.onChangeText('/model'))
    expect(readMobileNativeChatDraftInputs(key).skills).toEqual([])
    await act(async () => button('Save edited message').props.onPress())
    expect(error).toHaveBeenCalledTimes(2)
    expect(
      sendRequest.mock.calls.some(([method]) =>
        /(?:Update|send|conversationCommand|pty)/.test(method)
      )
    ).toBe(false)
    expect(state.hook!.queued.editor).toBeDefined()
  })

  it('an image-only attributed card reaches the actual inline composer and no-op Save retains its image and sender', async () => {
    const message = queuedDraft({
      messageId: 'photo-only',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'image-ref', url: 'https://host/photo.png', alt: 'photo' }],
        from: { kind: 'agent', senders: [], orchestration: null }
      }
    })
    const { root, button } = await rows(message)
    expect(root().findByType(MobileNativeChatComposer).props.attachments).toHaveLength(1)
    await act(async () => button('Save edited message').props.onPress())
    expect(state.hook!.queued.editor).toBeUndefined()
    expect(
      sendRequest.mock.calls.some(([method]) => method === 'agentSession.queuedMessageUpdate')
    ).toBe(false)
    expect(state.hook!.queued.cards[0]?.images).toEqual(message.body.blocks)
    expect(state.hook!.queued.cards[0]?.attribution).not.toBeNull()
    expect(state.bottomText).toBe('')
  })

  it.each(['question', 'approval'] as const)(
    'automatic/mail More→Edit→Save persists user authorship, position and options across journal reopen under %s',
    async (kind) => {
      const { createQueuedMessageTestRig, QUEUED_RIG_CALLER } =
        await import('../../../src/main/native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture')
      const { HOST_TEST_SESSION, HOST_TEST_NOW } =
        await import('../../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data')
      const { QueuedMessageEditHoldParams } =
        await import('../../../src/shared/rpc-contract/structured-agent-session-queued-edit-params')
      const { ok, snapshotEvent } =
        await import('./use-mobile-structured-agent-session-queued.test-fixture')
      const clock = vi.spyOn(Date, 'now').mockReturnValue(HOST_TEST_NOW)
      const rig = await createQueuedMessageTestRig()
      try {
        await rig.workingSend()
        const journal = () =>
          rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
        const from = { kind: 'agent' as const, senders: [], orchestration: null }
        const before = await journal().queuedMessages.insert({
          messageId: `mail-${kind}`,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'mail intent' }],
            sentAs: 'goal',
            from
          },
          options: { model: 'saved-model', effort: 'high' }
        })
        const { button, field, open } = await rows(before, 'codex', HOST_TEST_SESSION)
        act(() => state.hook!.queued.editor!.cancel())
        const prompt = snapshotEvent({
          queuedMessages: [before],
          items: [
            {
              itemId: 'prompt',
              revision: 1,
              sequence: 1,
              observedAt: 1,
              body: {
                kind,
                ...(kind === 'question' ? { question: 'Pick' } : { title: 'Allow?', detail: null }),
                options: [{ id: 'yes', label: 'Yes' }],
                resolution: {
                  state: 'pending',
                  selectedOptionId: null,
                  resolvedBy: null,
                  resolvedAt: null
                }
              }
            }
          ]
        })
        act(() =>
          state.listener?.({
            ...prompt,
            sessionId: HOST_TEST_SESSION,
            page: { ...prompt.page, sessionId: HOST_TEST_SESSION }
          })
        )
        await open()
        const hostResults: unknown[] = []
        sendRequest.mockImplementation(async (method, params) => {
          if (method === 'agentSession.queuedMessageEditHold') {
            return ok(
              await rig.host.queuedMessageEditHold(
                QUEUED_RIG_CALLER,
                QueuedMessageEditHoldParams.parse(params)
              )
            )
          }
          if (method !== 'agentSession.queuedMessageUpdate') {
            return readOrHoldReply(method, params)
          }
          const { envelope: clientEnvelope, ...fields } = QueuedMessageUpdateParams.parse(params)
          const result = await rig.host.queuedMessageUpdate(QUEUED_RIG_CALLER, {
            ...fields,
            envelope: rig.envelope(fields, method, clientEnvelope.clientOperationId)
          })
          hostResults.push(result)
          return ok(result)
        })
        // Equal Save proves no durable sender mutation or update RPC.
        await act(async () => button('Save edited message').props.onPress())
        expect(journal().queuedMessages.get(before.messageId)?.body.from).toEqual(from)
        expect(
          sendRequest.mock.calls.some(([method]) => method === 'agentSession.queuedMessageUpdate')
        ).toBe(false)
        await open()
        act(() => field().props.onChangeText('user replacement'))
        await act(async () => button('Save edited message').props.onPress())
        expect(hostResults, JSON.stringify(hostResults)).toMatchObject([
          { ok: true, value: { status: 'updated' } }
        ])
        expect(error.mock.calls).toEqual([])
        expect(state.hook!.queued.editor).toBeUndefined()
        const accepted = journal().queuedMessages.get(before.messageId)!
        expect(accepted).toMatchObject({
          position: before.position,
          options: before.options,
          body: { sentAs: 'goal', blocks: [{ type: 'text', text: 'user replacement' }] }
        })
        expect(accepted.body).not.toHaveProperty('from')
        await rig.restartHostProcess()
        await rig.drafts()
        const reopened = journal().queuedMessages.get(before.messageId)!
        expect(reopened).toEqual(accepted)
        const publication = snapshotEvent({ queuedMessages: [reopened] })
        act(() =>
          state.listener?.({
            ...publication,
            sessionId: HOST_TEST_SESSION,
            page: { ...publication.page, sessionId: HOST_TEST_SESSION }
          })
        )
        await open()
        expect(state.hook!.queued.editor?.text).toBe('user replacement')
        expect(state.hook!.queued.cards[0]?.attribution).toBeNull()
      } finally {
        await rig.dispose()
        clock.mockRestore()
      }
    },
    15000
  )

  it('keeps the occupied real bottom mounted through transferred picker completion and sends combined text/files/skills/images once', async () => {
    const { snapshotEvent, ok, fieldsOf } =
      await import('./use-mobile-structured-agent-session-queued.test-fixture')
    const message = queuedDraft({
      messageId: 'pending-files',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '$review intent' }],
        skills: [{ name: 'review', path: '/edit/SKILL.md' }]
      }
    })
    function Bottom({ session }: { session: NonNullable<typeof state.hook> }) {
      const text = useMobileNativeChatDraft('original-bottom')
      const files = useMobileNativeChatFileAttachments({
        client,
        sessionId: SESSION_ID,
        scopeKey: 'original-bottom',
        enabled: true,
        showToast: error
      })
      const images = useMobileNativeChatImageAttachments({
        client,
        agent: 'codex',
        activeHandleRef: { current: null },
        deviceTokenRef: { current: null },
        getActiveWorktreeConnectionId: async () => null,
        connState: 'connected',
        scopeKey: 'original-bottom',
        enabled: true,
        structuredNativeChat: true,
        showToast: error,
        onSendError: error,
        baseSend: session.sendWithOutcome,
        readSeededLaunchDraft: () => null,
        files: files.files,
        onFilesSent: files.removeFiles
      })
      return createElement(MobileNativeChatComposer, {
        value: text,
        agent: 'codex',
        draftScopeKey: 'original-bottom',
        onChangeText: (text) => setMobileNativeChatDraftText('original-bottom', text),
        onSend: images.sendNativeChat,
        sendSurfaceId: 'original-bottom',
        getSendCompletionGeneration: () => 0,
        getComposerEditGeneration: () => 0,
        attachments: images.attachments,
        structured: {
          catalog: { reported: [], conversationCommands: [] },
          onSlashMenuOpen: () => {},
          files: files.files,
          onRemoveFile: () => {}
        }
      })
    }
    const { root } = await rows(message, 'codex', SESSION_ID, { reported: [] }, (hook) =>
      createElement(Bottom, { session: hook })
    )
    act(() => {
      setMobileNativeChatDraftText('original-bottom', '$prior occupied')
      updateMobileNativeChatDraftInputs('original-bottom', () => ({
        images: [{ id: 'prior-image', path: '/prior.png', previewUri: 'file:///prior.png' }],
        files: [
          {
            id: 'prior-file',
            path: '/prior.txt',
            name: 'prior.txt',
            mime: 'text/plain',
            byteLength: 1
          }
        ],
        skills: [{ name: 'prior', path: '/prior/SKILL.md' }]
      }))
      updateMobileNativeChatDraftInputs(state.hook!.queued.editor!.scopeKey, (input) => ({
        ...input,
        images: [{ id: 'edit-image', path: '/added.png', previewUri: 'file:///added.png' }]
      }))
    })
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = () => {}
    const start = new Promise<void>((resolve) => {
      started = resolve
    })
    picker.pickFiles.mockImplementation(async function* () {
      yield { name: 'late.txt', mime: 'text/plain', byteLength: 1, base64: 'YQ==' }
    })
    sendRequest.mockImplementation(async (method, params) => {
      if (method.endsWith('uploadStart')) {
        started()
        await held
        return ok({ uploadId: 'pending-upload' })
      }
      if (method.endsWith('uploadCommit')) {
        return ok({ path: '/late.txt', name: 'late.txt', byteLength: 1 })
      }
      if (method.endsWith('uploadChunk')) {
        return ok(null)
      }
      if (method === 'agentSession.send') {
        return mutationOk({
          clientMessageId: fieldsOf(fieldsOf(params).envelope).clientOperationId
        })
      }
      return readOrHoldReply(method, params)
    })
    const inline = root()
      .findByType(MobileQueuedMessageComposer)
      .findByType(MobileNativeChatComposer)
    await act(async () => {
      inline.props.structured.onAttachFiles()
      await start
    })
    const beforeBottom = root()
      .findAllByType(MobileNativeChatComposer)
      .find((node) => node.props.draftScopeKey === 'original-bottom')!
    act(() => state.listener?.(snapshotEvent({ queuedMessages: [] })))
    expect(root().findByType(MobileNativeChatComposer)).toBe(beforeBottom)
    expect(state.hook!.queued.editor).toBeUndefined()
    const pressSend = () =>
      root()
        .findAll(
          (node) =>
            node.props.accessibilityLabel === 'Send message' &&
            typeof node.props.onPress === 'function'
        )[0]!
        .props.onPress()
    await act(async () => pressSend())
    expect(sendRequest.mock.calls.some(([method]) => method === 'agentSession.send')).toBe(false)
    await act(async () => {
      release()
      await vi.waitFor(() =>
        expect(readMobileNativeChatDraftInputs('original-bottom').pending ?? 0).toBe(0)
      )
    })
    await act(async () => pressSend())
    const requests = sendRequest.mock.calls.filter(([method]) => method === 'agentSession.send')
    expect(requests).toHaveLength(1)
    expect(requests[0]![1]).toMatchObject({
      body: {
        blocks: [
          { type: 'text', text: '$prior occupied\n\n$review intent\n@/prior.txt @/late.txt' },
          { type: 'image-ref', path: '/prior.png' },
          { type: 'image-ref', path: '/added.png' }
        ],
        skills: [
          { name: 'prior', path: '/prior/SKILL.md' },
          { name: 'review', path: '/edit/SKILL.md' }
        ]
      }
    })
    expect(readMobileNativeChatDraftInputs('original-bottom').files).toEqual([])
    expect(readMobileNativeChatDraftInputs('original-bottom').images).toEqual([])
  })

  it.each(['updated', 'unknown', 'refused', 'unknown-phase'] as const)(
    'real phone Cancel revokes pending/unknown Save before late %s and cannot mutate a new edit',
    async (mode) => {
      const { batchEvent, fieldsOf } =
        await import('./use-mobile-structured-agent-session-queued.test-fixture')
      const message = queuedDraft({ messageId: 'pending-cancel' })
      const other = queuedDraft({ messageId: 'new-edit', position: 2 })
      const host = queuedEditHost(SESSION_ID, message)
      const { button, field } = await rows(message)
      act(() => setMobileNativeChatDraftText('original-bottom', 'occupied'))
      act(() => field().props.onChangeText('B'))
      act(() => field().props.onFocus())
      const dictate = captureMobileNativeChatTextDestination()!
      expect(dictate).toBeTypeOf('function')
      const oldScope = state.hook!.queued.editor!.scopeKey
      const destination = mobileNativeChatDraftDestination(oldScope)
      let release = () => {}
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      let oldEditId = ''
      sendRequest.mockImplementation(async (method, params) => {
        if (
          method === 'agentSession.queuedMessageEditHold' &&
          fieldsOf(params).action === 'release'
        ) {
          oldEditId = String(fieldsOf(params).editId)
        }
        if (method !== 'agentSession.queuedMessageUpdate') {
          return readOrHoldReply(method, params)
        }
        const decision =
          mode === 'refused'
            ? { status: 'not-editable' as const, messageId: message.messageId }
            : host.update(QueuedMessageUpdateParams.parse(params))
        expect(decision.status).toBe(mode === 'refused' ? 'not-editable' : 'updated')
        await pending
        if (mode === 'unknown' || mode === 'unknown-phase') {
          throw markRpcDeliveryUnknown(new Error('lost'))
        }
        return mutationOk(decision)
      })
      let save!: Promise<void>
      act(() => {
        save = button('Save edited message').props.onPress()
      })
      expect(state.hook!.queued.editor?.saving).toBe(true)
      expect(field().props.editable).toBe(false)
      expect(button('Save edited message').props.disabled).toBe(true)
      expect(button('Cancel editing').props.disabled ?? false).toBe(false)
      if (mode === 'unknown-phase') {
        await act(async () => {
          release()
          await save
        })
        expect(state.hook!.queued.editor?.saving).toBe(false)
        expect(field().props.editable).toBe(true)
      }
      await act(async () => button('Cancel editing').props.onPress())
      expect(state.hook!.queued.editor).toBeUndefined()
      expect(destination.active).toBe(false)
      expect(oldEditId).not.toBe('')
      expect(state.bottomText).toBe('occupied')
      act(() => state.listener?.(batchEvent([message, other])))
      await act(async () => {
        await state.hook!.queued.edit!(other.messageId)
      })
      act(() => field().props.onChangeText('fresh input'))
      const newScope = state.hook!.queued.editor!.scopeKey
      act(() => expect(dictate('late speech')).toBe(false))
      await act(async () => {
        release()
        await save
      })
      act(() => state.listener?.(batchEvent([{ ...message, body: host.row!.body }, other])))
      expect(state.hook!.queued.editor).toMatchObject({
        messageId: other.messageId,
        text: 'fresh input',
        scopeKey: newScope,
        saving: false
      })
      expect(state.bottomText).toBe('occupied')
      expect(readMobileNativeChatDraftInputs(oldScope)).toMatchObject({
        files: [],
        images: [],
        skills: []
      })
      expect(error).not.toHaveBeenCalled()
      expect(resolved).not.toHaveBeenCalled()
      expect(
        sendRequest.mock.calls.filter(
          ([method, params]) =>
            method === 'agentSession.queuedMessageEditHold' &&
            fieldsOf(params).action === 'release' &&
            fieldsOf(params).editId === oldEditId
        )
      ).toHaveLength(1)
      host.leases.dispose()
    }
  )

  it.each(['files', 'images'] as const)(
    'real %s upload Cancel revokes its captured destination while normal pending admission blocks Save',
    async (kind) => {
      const { ok } = await import('./use-mobile-structured-agent-session-queued.test-fixture')
      const message = queuedDraft({ messageId: `cancel-${kind}` })
      const { root, button } = await rows(message)
      act(() => setMobileNativeChatDraftText('original-bottom', 'occupied'))
      const scope = state.hook!.queued.editor!.scopeKey
      const destination = mobileNativeChatDraftDestination(scope)
      let release = () => {}
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      let started = () => {}
      const start = new Promise<void>((resolve) => {
        started = resolve
      })
      picker.pickFiles.mockImplementation(async function* () {
        yield { name: 'late.txt', mime: 'text/plain', byteLength: 1, base64: 'YQ==' }
        yield { name: 'never.txt', mime: 'text/plain', byteLength: 1, base64: 'Yg==' }
      })
      picker.pickImages.mockResolvedValue([
        { base64: 'YQ==', uri: 'file:///late.png' },
        { base64: 'Yg==', uri: 'file:///never.png' }
      ])
      const isStart = (method: string) =>
        method.endsWith('uploadStart') || method === 'clipboard.startImageUpload'
      sendRequest.mockImplementation(async (method, params) => {
        if (isStart(method)) {
          started()
          await pending
          return ok({ uploadId: 'held' })
        }
        if (method === 'clipboard.commitImageUpload') {
          return ok('/late.png')
        }
        if (method.endsWith('uploadCommit')) {
          return ok({ path: '/late.txt', name: 'late.txt', byteLength: 1 })
        }
        if (method.includes('uploadChunk') || method === 'clipboard.appendImageUploadChunk') {
          return ok(null)
        }
        return readOrHoldReply(method, params)
      })
      const inline = root()
        .findByType(MobileQueuedMessageComposer)
        .findByType(MobileNativeChatComposer)
      await act(async () => {
        if (kind === 'files') {
          inline.props.structured.onAttachFiles()
        } else {
          inline.props.onAttachImage()
        }
        await start
      })
      expect(readMobileNativeChatDraftInputs(scope).pending).toBe(1)
      expect(state.hook!.queued.editor!.canSave).toBe(false)
      expect(button('Save edited message').props.disabled).toBe(true)
      expect(button('Cancel editing').props.disabled ?? false).toBe(false)
      await act(async () => button('Cancel editing').props.onPress())
      expect(destination.active).toBe(false)
      expect(state.hook!.queued.editor).toBeUndefined()
      await act(async () => {
        release()
        await vi.waitFor(() =>
          expect(
            sendRequest.mock.calls.some(
              ([method]) =>
                method.endsWith('uploadCommit') || method === 'clipboard.commitImageUpload'
            )
          ).toBe(true)
        )
      })
      expect(sendRequest.mock.calls.filter(([method]) => isStart(method))).toHaveLength(1)
      expect(
        sendRequest.mock.calls.some(([method]) => method === 'agentSession.queuedMessageUpdate')
      ).toBe(false)
      expect(readMobileNativeChatDraftInputs(scope)).toMatchObject({
        files: [],
        images: [],
        skills: []
      })
      expect(readMobileNativeChatDraftInputs('original-bottom')).toMatchObject({
        files: [],
        images: []
      })
      expect(state.bottomText).toBe('occupied')
      expect(error).not.toHaveBeenCalled()
    }
  )
})
