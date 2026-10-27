import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'
import {
  useMobileNativeChatDraft,
  setMobileNativeChatDraftText,
  clearMobileNativeChatDraftForSend,
  readMobileNativeChatDraftEditGeneration
} from './mobile-native-chat-draft-store'
import {
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs,
  resetMobileNativeChatDraftInputsForTests
} from './mobile-native-chat-draft-inputs'
import { useMobileStructuredAgentSession } from '../../use-mobile-structured-agent-session'
import {
  CAPABLE,
  SESSION_ID,
  snapshotEvent,
  mutationOk,
  ok
} from '../../use-mobile-structured-agent-session-queued.test-fixture'
import { structuredSendResultFixture } from '../../structured-agent-send-result.test-fixture'
import type { RpcClient } from '../../../transport/rpc-client'
vi.mock('../../../platform/media-picker', () => ({
  useMediaPicker: () => ({ pickImages: async () => [] })
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))
import { createElement, type ComponentProps } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatComposer as NativeChatComposer } from './MobileNativeChatComposer'

const getNoComposerEditGeneration = () => 0

function MobileNativeChatComposer({
  getComposerEditGeneration = getNoComposerEditGeneration,
  ...props
}: Omit<ComponentProps<typeof NativeChatComposer>, 'getComposerEditGeneration'> & {
  getComposerEditGeneration?: () => number
}): React.JSX.Element {
  return createElement(NativeChatComposer, { ...props, getComposerEditGeneration })
}

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    Keyboard: { dismiss: vi.fn() },
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement('ScrollView', props, children),
    StyleSheet: {
      create: (styles: unknown) => styles,
      hairlineWidth: 1
    },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View'
  }
})

vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  AtSign: 'AtSign',
  Image: 'Image',
  Paperclip: 'Paperclip',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  FileText: 'FileText',
  Mic: 'Mic',
  Package: 'Package',
  Plus: 'Plus',
  ShieldAlert: 'ShieldAlert',
  Square: 'Square',
  Terminal: 'Terminal',
  X: 'X'
}))

vi.mock('../../../components/mounted-bottom-drawer', () => ({
  MountedBottomDrawer: 'BottomDrawer'
}))
vi.mock('../../../components/bottom-drawer-modal-host-scope', () => ({
  useBottomDrawerModalHost: () => null
}))

const structured = (
  overrides: Partial<NonNullable<ComponentProps<typeof NativeChatComposer>['structured']>> = {}
) => ({
  catalog: {
    reported: [
      { name: 'compact', kind: 'command' as const },
      { name: 'review-pr', kind: 'skill' as const, description: 'Review a pull request' }
    ],
    conversationCommands: []
  },
  onSlashMenuOpen: vi.fn(),
  files: [],
  onRemoveFile: vi.fn(),
  ...overrides
})

describe('MobileNativeChatComposer on a structured chat', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  const draw = (props: Partial<ComponentProps<typeof MobileNativeChatComposer>>) =>
    createElement(MobileNativeChatComposer, {
      value: '',
      onChangeText: vi.fn(),
      onSend: vi.fn().mockResolvedValue(true),
      sendSurfaceId: 'tab-a',
      getSendCompletionGeneration: () => 0,
      agent: 'claude',
      ...props
    })
  const field = () => renderer!.root.find((node) => node.props.multiline === true)
  const labelled = (label: string) =>
    renderer!.root.findAll(
      (node) => node.props.accessibilityLabel === label && node.props.onPress !== undefined
    )
  const drawers = () => renderer!.root.findAll((node) => node.props.onHidden !== undefined)

  it.each(['', 'See this'])(
    'sends an ordinary image with %j text through the real RPC and clears its visible chip',
    async (text) => {
      const scope = `image-rpc-${text}`
      resetMobileNativeChatDraftInputsForTests()
      updateMobileNativeChatDraftInputs(scope, (input) => ({
        ...input,
        images: [{ id: 'photo', path: '/remote/photo.png', previewUri: 'file:///phone-photo.png' }]
      }))
      let publish: ((data: unknown) => void) | undefined
      const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method) =>
        method === 'agentSession.send'
          ? mutationOk(structuredSendResultFixture('accepted'))
          : ok({ models: [], current: {} })
      )
      const client: RpcClient = {
        sendRequest,
        subscribe: (_m, _p, listener) => {
          publish = listener
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
      function Conversation() {
        const session = useMobileStructuredAgentSession({
          client,
          sessionId: SESSION_ID,
          sourceIdentity: 'host',
          enabled: true,
          connected: true,
          agent: 'codex',
          hostSupport: CAPABLE,
          composerScopeKey: scope,
          onSendError: vi.fn()
        })
        const image = useMobileNativeChatImageAttachments({
          client,
          agent: 'codex',
          activeHandleRef: { current: null },
          deviceTokenRef: { current: null },
          getActiveWorktreeConnectionId: async () => null,
          connState: 'connected',
          scopeKey: scope,
          enabled: true,
          structuredNativeChat: true,
          showToast: vi.fn(),
          onSendError: vi.fn(),
          baseSend: session.sendWithOutcome,
          readSeededLaunchDraft: () => null
        })
        return draw({
          value: text,
          onSend: image.sendNativeChat,
          attachments: image.attachments,
          onRemoveAttachment: image.removeAttachment,
          structured: structured()
        })
      }
      await act(async () => {
        renderer = create(createElement(Conversation))
      })
      act(() => publish?.(snapshotEvent()))
      expect(labelled('Remove image')[0]).toBeDefined()
      await act(async () => labelled('Send message')[0]!.props.onPress())
      const request = sendRequest.mock.calls.find(([method]) => method === 'agentSession.send')?.[1]
      expect(request).toMatchObject({
        body: {
          blocks: [
            ...(text ? [{ type: 'text', text }] : []),
            { type: 'image-ref', path: '/remote/photo.png' }
          ]
        }
      })
      expect(readMobileNativeChatDraftInputs(scope).images).toEqual([])
      expect(labelled('Remove image')).toEqual([])
    }
  )

  it.each([
    ['codex', '$review.v2'],
    ['claude', '/review.v2']
  ] as const)(
    '%s carries an ordinary menu pick through the real Send RPC, clears on acceptance and forgets deleted identities',
    async (agent, token) => {
      const scope = 'normal-menu-rpc'
      resetMobileNativeChatDraftInputsForTests()
      setMobileNativeChatDraftText(scope, '/re')
      let publish: ((data: unknown) => void) | undefined
      const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method) =>
        method === 'agentSession.send'
          ? mutationOk(structuredSendResultFixture('accepted'))
          : ok({ models: [], current: {} })
      )
      const client: RpcClient = {
        sendRequest,
        subscribe: (_m, _p, listener) => {
          publish = listener
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
      function Conversation() {
        const value = useMobileNativeChatDraft(scope)
        const session = useMobileStructuredAgentSession({
          client,
          sessionId: SESSION_ID,
          sourceIdentity: 'host',
          enabled: true,
          connected: true,
          agent,
          hostSupport: CAPABLE,
          composerScopeKey: scope,
          onSendError: vi.fn()
        })
        return createElement(MobileNativeChatComposer, {
          value,
          agent,
          draftScopeKey: scope,
          onChangeText: (text) => setMobileNativeChatDraftText(scope, text),
          onPickSkill: (skill) =>
            updateMobileNativeChatDraftInputs(scope, (input) => ({
              ...input,
              skills: [...input.skills, skill]
            })),
          onSend: async (text) => {
            const generation = readMobileNativeChatDraftEditGeneration(scope)
            const accepted = (await session.sendWithOutcome(text)) === 'accepted'
            if (accepted) {
              clearMobileNativeChatDraftForSend(scope, generation, text)
            }
            return accepted
          },
          sendSurfaceId: scope,
          getSendCompletionGeneration: () => 0,
          getComposerEditGeneration: () => readMobileNativeChatDraftEditGeneration(scope),
          structured: structured({
            catalog: {
              reported: [{ name: 'review.v2', kind: 'skill', path: '/remote/review/SKILL.md' }],
              conversationCommands: []
            }
          })
        })
      }
      await act(async () => {
        renderer = create(createElement(Conversation))
      })
      act(() => publish?.(snapshotEvent()))
      act(() => field().props.onSelectionChange({ nativeEvent: { selection: { end: 3 } } }))
      await act(async () => labelled(token)[0]!.props.onPress())
      expect(field().props.value).toBe(`${token} `)
      await act(async () => labelled('Send message')[0]!.props.onPress())
      const request = sendRequest.mock.calls.find(([method]) => method === 'agentSession.send')?.[1]
      expect(request).toMatchObject({
        body: {
          blocks: [{ type: 'text', text: token }],
          skills: [{ name: 'review.v2', path: '/remote/review/SKILL.md' }]
        }
      })
      expect(field().props.value).toBe('')
      expect(readMobileNativeChatDraftInputs(scope).skills).toEqual([])
      act(() => field().props.onChangeText(`${token} `))
      await act(async () => labelled('Send message')[0]!.props.onPress())
      expect(
        sendRequest.mock.calls.findLast(([method]) => method === 'agentSession.send')?.[1]
      ).not.toHaveProperty('body.skills')
      // Pick again, delete, then retype: text alone cannot resurrect the old remote identity.
      act(() => field().props.onChangeText('/re'))
      act(() => field().props.onSelectionChange({ nativeEvent: { selection: { end: 3 } } }))
      await act(async () => labelled(token)[0]!.props.onPress())
      act(() => field().props.onChangeText(''))
      act(() => field().props.onChangeText(`${token} `))
      expect(readMobileNativeChatDraftInputs(scope).skills).toEqual([])
    }
  )

  it('puts a picked skill at the start of the draft, highlighted, and deletes it as one unit', async () => {
    const onChangeText = vi.fn()
    const catalog = structured()
    await act(async () => {
      renderer = create(draw({ value: '/re', onChangeText, structured: catalog }))
    })
    await act(async () =>
      field().props.onSelectionChange({ nativeEvent: { selection: { end: 3 } } })
    )
    expect(catalog.onSlashMenuOpen).toHaveBeenCalled()
    await act(async () => labelled('/review-pr')[0]!.props.onPress())
    expect(onChangeText).toHaveBeenLastCalledWith('/review-pr ')
    expect(field().props.selection).toEqual({ start: 11, end: 11 })

    await act(async () =>
      renderer!.update(draw({ value: '/review-pr focus', onChangeText, structured: catalog }))
    )
    const token = field().find((node) => node.props.children === '/review-pr')
    expect(token.props.style).toMatchObject({ backgroundColor: expect.any(String) })
    await act(async () => field().props.onChangeText('/review-pr focus on auth'))
    expect(onChangeText).toHaveBeenLastCalledWith('/review-pr focus on auth')
    await act(async () => field().props.onChangeText('/review-prfocus'))
    expect(onChangeText).toHaveBeenLastCalledWith('focus')
  })

  it('opens the + sheet on a structured chat, and the photo library at once otherwise', async () => {
    const onAttachImage = vi.fn()
    await act(async () => {
      renderer = create(draw({ onAttachImage, structured: structured() }))
    })
    await act(async () => labelled('Add to message')[0]!.props.onPress())
    expect(onAttachImage).not.toHaveBeenCalled()
    expect(drawers()).toHaveLength(1)

    await act(async () => renderer!.update(draw({ onAttachImage, structured: null })))
    await act(async () => labelled('Attach image')[0]!.props.onPress())
    expect(onAttachImage).toHaveBeenCalledTimes(1)
  })

  it('holds Send while a file is still uploading, and sends a stored file alone', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const file = { id: 'f1', name: 'spec.pdf', mime: 'application/pdf', byteLength: 10 }
    await act(async () => {
      renderer = create(
        draw({
          value: 'see attached',
          onSend,
          structured: structured({ files: [{ ...file, path: null }] })
        })
      )
    })
    expect(labelled('Send message')[0]!.props.disabled).toBe(true)
    await act(async () => labelled('Send message')[0]!.props.onPress())
    expect(onSend).not.toHaveBeenCalled()
    await act(async () =>
      renderer!.update(
        draw({ onSend, structured: structured({ files: [{ ...file, path: '/s/spec.pdf' }] }) })
      )
    )
    expect(labelled('Send message')[0]!.props.disabled).toBe(false)
    await act(async () => labelled('Send message')[0]!.props.onPress())
    expect(onSend).toHaveBeenCalledExactlyOnceWith('')
  })
})
