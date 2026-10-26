// @vitest-environment happy-dom
import { useLayoutEffect, useRef } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { useNativeChatDraft } from './use-native-chat-draft'
import { promptText, promptSkillRefs } from './native-chat-prompt-document'
import {
  createNativeChatQueuedEditDraft,
  handBackNativeChatQueuedEdit,
  discardNativeChatQueuedEdit
} from './native-chat-queued-edit-draft'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts
} from './native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'
import {
  replayNativeChatComposerDraftJournal,
  snapshotNativeChatComposerDraftJournal
} from './native-chat-composer-draft-journal'
import { resolveNativeChatPastedText } from './native-chat-composer-pasted-text-references'
import { nativeChatPastedTextToken } from './native-chat-pasted-text-reference'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'

const scope = 'agent-session:rich-return'
let composing = false
function Bottom() {
  const input = useRef<NativeChatComposerInput>(null)
  const draft = useNativeChatDraft(scope, () => composing)
  useLayoutEffect(() => {
    if (!composing && input.current && input.current.value !== draft.draft) {
      input.current.value = draft.draft
    }
  }, [draft.draft])
  return (
    <NativeChatPromptEditor
      scopeKey={scope}
      inputRef={input}
      initialValue={draft.draft}
      disabled={false}
      placeholder="Bottom"
      onChange={(field) => draft.setDraft(field.value)}
      onSelect={() => {}}
    />
  )
}
function returned(text = '$review') {
  const edit = createNativeChatQueuedEditDraft(
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text }],
      skills: [{ name: 'review', path: '/returned/SKILL.md' }]
    },
    scope
  )
  updateNativeChatComposerDraft(
    edit.scopeKey,
    {
      text: `${text} changed`,
      document: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'nativeChatSkill', attrs: { token: '$review', path: '/returned/SKILL.md' } },
              { type: 'text', text: ' changed' }
            ]
          }
        ]
      }
    },
    'immediate'
  )
  return edit
}
function nextSend() {
  const draft = readNativeChatComposerDraft(scope)
  return structuredAgentSessionSendBody(
    resolveNativeChatPastedText(scope, draft.text),
    draft.images.map((image) => ({ ...image, previewUri: image.path })),
    promptSkillRefs(draft.document)
  )
}
beforeEach(async () => {
  composing = false
  localStorage.clear()
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
})
afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
})

it.each(['/clear', 'typed  \n\n'])(
  'normalizes rich return over %j through the mounted editor and next Send',
  (before) => {
    updateNativeChatComposerDraft(scope, { text: before, images: [] }, 'immediate')
    render(<Bottom />)
    const edit = returned()
    act(() => {
      handBackNativeChatQueuedEdit(edit)
      discardNativeChatQueuedEdit(edit)
    })
    const editor = promptEditor(screen.getByRole('textbox'))
    const expected = before === '/clear' ? '$review changed' : 'typed\n\n$review changed'
    expect(promptText(editor.state.doc)).toBe(expected)
    act(() => editor.commands.insertContentAt(editor.state.doc.content.size - 1, '!'))
    expect(nextSend()).toMatchObject({
      blocks: [{ type: 'text', text: `${expected}!` }],
      skills: [{ name: 'review', path: '/returned/SKILL.md' }]
    })
  }
)

it('keeps equal visible skill tokens with distinct selected paths through return and Send', () => {
  const bottom = createNativeChatQueuedEditDraft(
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: '$review changed' }],
      skills: [{ name: 'review', path: '/bottom/SKILL.md' }]
    },
    'unused'
  )
  updateNativeChatComposerDraft(scope, readNativeChatComposerDraft(bottom.scopeKey), 'immediate')
  render(<Bottom />)
  const edit = returned()
  act(() => {
    handBackNativeChatQueuedEdit(edit)
    discardNativeChatQueuedEdit(edit)
  })
  expect(promptText(promptEditor(screen.getByRole('textbox')).state.doc)).toBe(
    '$review changed\n\n$review changed'
  )
  expect(nextSend().skills).toEqual([
    { name: 'review', path: '/bottom/SKILL.md' },
    { name: 'review', path: '/returned/SKILL.md' }
  ])
  discardNativeChatQueuedEdit(bottom)
})

it('keeps a rich return through an actual composing editor transaction and next Send', () => {
  updateNativeChatComposerDraft(scope, { text: 'typed', images: [] }, 'immediate')
  render(<Bottom />)
  const editor = promptEditor(screen.getByRole('textbox'))
  composing = true
  const edit = returned()
  act(() => {
    handBackNativeChatQueuedEdit(edit)
    discardNativeChatQueuedEdit(edit)
  })
  expect(promptText(editor.state.doc)).toBe('typed')
  act(() =>
    editor.view.dispatch(editor.state.tr.insertText('가', editor.state.doc.content.size - 1))
  )
  expect(readNativeChatComposerDraft(scope).text).toBe('typed가\n\n$review changed')
  expect(nextSend().skills).toEqual([{ name: 'review', path: '/returned/SKILL.md' }])
})

it('replays a full rich addition into existing content, renders it and sends resolved files/images/skills', () => {
  const edit = returned()
  const paste = 'd851d135-98ac-44d1-b122-caf190002345'
  const draft = readNativeChatComposerDraft(edit.scopeKey)
  updateNativeChatComposerDraft(
    edit.scopeKey,
    {
      text: `${draft.text}\n${nativeChatPastedTextToken(paste)}`,
      document: {
        ...draft.document,
        content: [
          ...(draft.document?.content ?? []),
          {
            type: 'paragraph',
            content: [
              {
                type: 'nativeChatFileReference',
                attrs: { token: nativeChatPastedTextToken(paste), path: '' }
              }
            ]
          }
        ]
      },
      pastedTextFiles: { [paste]: '/remote/paste.txt' },
      images: [{ id: 'new', path: '/new.png' }]
    },
    'immediate'
  )
  handBackNativeChatQueuedEdit(edit)
  discardNativeChatQueuedEdit(edit)
  // Simulate another renderer run reading the actual addition journal before storage confirmation.
  const raw = localStorage.getItem('orca:nativeChatComposerDraftJournal:v1')!
  localStorage.setItem(
    'orca:nativeChatComposerDraftJournal:v1',
    raw.replaceAll(/"run":"[^"]+"/g, '"run":"previous-run"')
  )
  const loaded = new Map<string, StoredNativeChatComposerDraft | null>([
    [scope, { text: 'existing', images: [], savedAt: 0 }]
  ])
  replayNativeChatComposerDraftJournal(loaded, snapshotNativeChatComposerDraftJournal())
  updateNativeChatComposerDraft(scope, loaded.get(scope)!, 'immediate')
  render(<Bottom />)
  expect(promptSkillRefs(promptEditor(screen.getByRole('textbox')).getJSON())).toEqual([
    { name: 'review', path: '/returned/SKILL.md' }
  ])
  expect(nextSend()).toMatchObject({
    blocks: [
      { type: 'text', text: expect.stringContaining('@/remote/paste.txt') },
      { type: 'image-ref', path: '/new.png' }
    ],
    skills: [{ name: 'review', path: '/returned/SKILL.md' }]
  })
})
