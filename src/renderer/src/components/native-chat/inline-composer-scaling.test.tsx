// @vitest-environment happy-dom
import { useLayoutEffect, useRef } from 'react'
import { useNativeChatRootInputRouting } from './use-native-chat-root-input-routing'
import {
  createNativeChatQueuedEditDraft,
  handBackNativeChatQueuedEdit,
  discardNativeChatQueuedEdit
} from './native-chat-queued-edit-draft'
import {
  updateNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests
} from './native-chat-composer-draft-store'
import {
  nativeChatPastedTextOperations,
  nativeChatPastedTextToken
} from './native-chat-pasted-text-reference'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  nativeChatPendingAttachmentSnapshot,
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  moveNativeChatPendingAttachments,
  settleNativeChatPendingAttachment,
  clearNativeChatPendingAttachments
} from './native-chat-pending-attachment-cache'
import {
  registerNativeChatComposerDestination,
  nativeChatComposerDestination,
  nativeChatComposerScopeDestination
} from './native-chat-composer-destination'
import {
  registerDictationComposerTarget,
  captureInsertionTarget
} from '../dictation/dictation-insertion-target'
import { NativeChatMentionMenu } from './NativeChatAutocompleteMenus'
import type { NativeChatComposerHandle } from './native-chat-composer-types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  clearNativeChatPendingAttachmentsForTests()
  clearNativeChatComposerDraftsForTests()
})

it.each([20, 200])(
  'completes moved and cancelled chips without inspecting %i unrelated scopes',
  (count) => {
    let inspected = 0
    for (let i = 0; i < count; i++) {
      const scope = `other-${i}`
      addNativeChatPendingAttachment(scope, { id: `chip-${i}`, path: '', pending: true })
      Object.defineProperty(nativeChatPendingAttachmentSnapshot(scope)[0], 'id', {
        get() {
          inspected++
          return `chip-${i}`
        }
      })
    }
    addNativeChatPendingAttachment('source', { id: 'moved', path: '', pending: true })
    moveNativeChatPendingAttachments('source', 'destination')
    inspected = 0
    expect(settleNativeChatPendingAttachment('source', 'moved', '/moved.png')).toBe(true)
    expect(settleNativeChatPendingAttachment('source', 'moved', '/again.png')).toBe(false)
    addNativeChatPendingAttachment('source', { id: 'cancel', path: '', pending: true })
    clearNativeChatPendingAttachments('source')
    expect(settleNativeChatPendingAttachment('source', 'cancel', '/late.png')).toBe(false)
    expect(inspected).toBe(0)
  }
)

it.each([20, 200])(
  'bounds destination lookup by this pane, independent of %i other panes',
  (count) => {
    const releases: (() => void)[] = []
    const holder = document.createElement('div')
    document.body.append(holder)
    let reads = 0
    const handle: NativeChatComposerHandle = {
      focus: () => true,
      insertTypedText: () => true,
      acceptsText: () => true,
      appendText: () => {},
      handlePasteEvent: () => {},
      pasteFromClipboard: () => {},
      contains: () => true
    }
    const pane = document.createElement('div')
    const input = document.createElement('textarea')
    pane.append(input)
    holder.append(pane)
    const owned = {
      get current() {
        reads++
        return handle
      }
    }
    releases.push(
      registerNativeChatComposerDestination(input, owned, true, 'captured-scope'),
      registerDictationComposerTarget(pane, () => {})
    )
    for (let i = 0; i < count; i++) {
      const other = document.createElement('div')
      holder.append(other)
      releases.push(
        registerNativeChatComposerDestination(
          other,
          {
            get current(): NativeChatComposerHandle | null {
              throw new Error('unrelated handle read')
            }
          },
          true,
          `other-scope-${i}`
        ),
        registerDictationComposerTarget(other, () => {})
      )
    }
    input.focus()
    const contains = vi.spyOn(HTMLElement.prototype, 'contains')
    expect(nativeChatComposerDestination(pane, null)).toBe(handle)
    expect(captureInsertionTarget()?.kind).toBe('composer')
    expect(reads).toBe(1)
    expect(nativeChatComposerScopeDestination('captured-scope')).toBe(handle)
    expect(reads).toBe(2)
    expect(contains).not.toHaveBeenCalled()
    releases.forEach((release) => release())
    expect(nativeChatComposerDestination(pane, null)).toBeNull()
    expect(nativeChatComposerScopeDestination('captured-scope')).toBeNull()
    holder.remove()
  }
)

it.each([10, 100])(
  'measures autocomplete only for its own scroll ancestors across %i menus and cleans up',
  (count) => {
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    const view = render(
      <>
        {Array.from({ length: count }, (_, index) => (
          <div key={index} data-scroll={index}>
            <NativeChatMentionMenu
              mention={{ files: ['/a.ts'], loading: false, failed: false }}
              activeIndex={0}
              listboxId={`menu-${index}`}
              onChoose={() => {}}
            />
          </div>
        ))}
      </>
    )
    expect(measure).toHaveBeenCalledTimes(count)
    measure.mockClear()
    act(() => view.container.querySelector('[data-scroll="0"]')!.dispatchEvent(new Event('scroll')))
    expect(measure).toHaveBeenCalledTimes(1)
    measure.mockClear()
    act(() => window.dispatchEvent(new Event('resize')))
    expect(measure).toHaveBeenCalledTimes(count)
    measure.mockClear()
    view.unmount()
    window.dispatchEvent(new Event('resize'))
    expect(measure).not.toHaveBeenCalled()
  }
)

// The actual capture route runs before the input skip gate.
it.each([20, 200])(
  'routes a real key with constant local handle reads beside %i other panes',
  (count) => {
    const releases: (() => void)[] = []
    let localReads = 0
    const inserted = vi.fn(() => true)
    const handle: NativeChatComposerHandle = {
      focus: () => true,
      insertTypedText: inserted,
      acceptsText: () => true,
      appendText: () => {},
      handlePasteEvent: () => {},
      pasteFromClipboard: () => {},
      contains: () => false
    }
    function Pane() {
      const rootRef = useRef<HTMLDivElement>(null)
      const composerRef = useRef<NativeChatComposerHandle | null>(handle)
      const questionAnswerInputRef = useRef<HTMLInputElement>(null)
      const routing = useNativeChatRootInputRouting({
        tabId: 'scaling',
        rootRef,
        composerRef,
        questionAnswerInputRef,
        isVisible: false,
        isFocusedGroup: false,
        composerReady: false
      })
      useLayoutEffect(
        () =>
          registerNativeChatComposerDestination(
            rootRef.current!,
            {
              get current() {
                localReads++
                return handle
              }
            },
            true
          ),
        []
      )
      return (
        <div ref={rootRef} onKeyDownCapture={routing.onKeyDownCapture}>
          <textarea aria-label="owned" />
          <span>transcript</span>
        </div>
      )
    }
    for (let i = 0; i < count; i++) {
      const other = document.createElement('div')
      document.body.append(other)
      releases.push(
        registerNativeChatComposerDestination(
          other,
          {
            get current(): NativeChatComposerHandle | null {
              throw new Error('unrelated handle read')
            }
          },
          true,
          `other-scope-${i}`
        ),
        () => other.remove()
      )
    }
    const view = render(<Pane />)
    fireEvent.keyDown(view.getByLabelText('owned'), { key: 'a' })
    expect(inserted).not.toHaveBeenCalled()
    fireEvent.keyDown(view.getByText('transcript'), { key: 'b' })
    expect(inserted).toHaveBeenCalledExactlyOnceWith('b')
    expect(localReads).toBe(2)
    releases.forEach((release) => release())
  }
)

it.each([20, 200])(
  'hand-back visits only its own paste operation beside %i unrelated operations',
  (count) => {
    const ownId = '00000000-0000-4000-8000-000000000001'
    let unrelatedReads = 0
    const edit = createNativeChatQueuedEditDraft(
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'old' }] },
      'bottom'
    )
    for (let i = 0; i < count; i++) {
      nativeChatPastedTextOperations.set(`other-${i}`, {
        get scopeKey() {
          unrelatedReads++
          return `other-${i}`
        },
        text: 'other'
      })
    }
    const operation = { scopeKey: edit.scopeKey, text: 'own' }
    nativeChatPastedTextOperations.set(ownId, operation)
    updateNativeChatComposerDraft(
      edit.scopeKey,
      { text: nativeChatPastedTextToken(ownId), images: [] },
      'immediate'
    )
    handBackNativeChatQueuedEdit(edit)
    expect(operation.scopeKey).toBe('bottom')
    expect(unrelatedReads).toBe(0)
    discardNativeChatQueuedEdit(edit)
    nativeChatPastedTextOperations.clear()
  }
)

import { queuedEditPublicationKey } from '../../../../shared/queued-message-edit-publication'
it.each([10, 100])(
  'bounds a semantic publication lookup to three linear ID passes and one body at %i cards',
  (count) => {
    let ids = 0,
      bodies = 0
    const messages = Array.from({ length: count }, (_, index) => ({
      get messageId() {
        ids++
        return `message-${index}`
      },
      position: index,
      state: 'waiting' as const,
      get body() {
        bodies++
        if (index !== count - 1) {
          throw new Error('unrelated body read')
        }
        return {
          kind: 'message' as const,
          role: 'user' as const,
          blocks: [{ type: 'text' as const, text: 'target' }]
        }
      }
    }))
    const submissions = Array.from({ length: count }, (_, index) => ({
      clientMessageId: `submission-${index}`,
      get queuedMessageId() {
        ids++
        return `message-${index}`
      },
      payloadFingerprint: 'proof',
      fence: index,
      dispatchState: 'pending' as const,
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: null
    }))
    queuedEditPublicationKey(
      { messages, cards: messages, submissions },
      'session',
      `message-${count - 1}`
    )
    expect(ids).toBe(3 * count)
    expect(bodies).toBe(1)
  }
)
