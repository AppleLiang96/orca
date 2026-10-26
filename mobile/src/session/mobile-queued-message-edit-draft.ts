import type { MobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'
import { textLeftAfterSubmission } from '../../../src/shared/submitted-draft-text'
import { appendBufferedDictation } from '../terminal/terminal-live-dictation-routing'
import type {
  MobileNativeChatDraftInputs,
  MobileNativeChatDraftDestination
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import type { AgentSessionQueuedMessage } from '../../../src/shared/agent-session-wire'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileQueuedEditLease } from './mobile-queued-message-edit-lease'
import {
  pickedSkillsInText,
  agentSessionSendBodyFingerprint
} from '../../../src/shared/structured-agent-session-send-mutation'
import {
  queuedEditKeptImages,
  queuedMessageEditableText,
  queuedEditTextForKeptImages
} from '../../../src/shared/queued-message-edit'
import { stripSentImagePromptMarkers } from '../../../src/shared/native-chat-image-transcript-markers'
import { appendReturnedDraftText } from '../../../src/shared/returned-draft-text'
import {
  closeMobileNativeChatEditInputs,
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import { setMobileNativeChatDraftText } from './native-chat/composer/mobile-native-chat-draft-store'
import { nativeChatTextWithFileReferences } from './native-chat/composer/mobile-native-chat-file-attachment'

export type MobileQueuedMessageInlineEditor = {
  messageId: string
  scopeKey: string
  client: RpcClient
  sessionId: string
  imagesCapable: boolean
  text: string
  saving: boolean
  canSave: boolean
  insertDictation?: (text: string) => boolean
  change: (text: string) => void
  save: () => Promise<boolean>
  removeImage: (id: string) => void
  cancel: () => void
}

export type MobileQueuedEditDraft = {
  scope: string
  client: RpcClient
  sessionId: string
  published: {
    messages: readonly AgentSessionQueuedMessage[] | null
    submissions: readonly AgentJournalSubmission[]
  }
  scopeKey: string
  destination: string | null
  handBackText: ((text: string) => boolean) | undefined
  messageId: string
  body: AgentSessionQueuedMessage['body']
  text: string
  fingerprint: string
  saving: boolean
  closed: boolean
  handedBack: boolean
  submitted?: {
    fingerprint: string
    text: string
    inputs: MobileNativeChatDraftInputs
  }
  pendingClose: boolean
  lease: MobileQueuedEditLease
}

export function closeMobileQueuedEditDraft(
  edit: MobileQueuedEditDraft,
  handBack: boolean,
  notice?: (text: string) => void
): void {
  if (edit.closed) {
    return
  }
  edit.closed = true
  edit.lease.end()
  if (handBack && !edit.handedBack) {
    const inputs = readMobileNativeChatDraftInputs(edit.scopeKey)
    const dirty =
      (inputs.pending ?? 0) > 0 ||
      edit.text !== queuedMessageEditableText(edit.body) ||
      inputs.files.length > 0 ||
      inputs.images.map(({ id }) => id).join() !==
        queuedEditKeptImages(edit.body)
          .map(({ id }) => id)
          .join() ||
      JSON.stringify(pickedSkillsInText(edit.text, inputs.skills)) !==
        JSON.stringify(
          pickedSkillsInText(queuedMessageEditableText(edit.body) ?? '', edit.body.skills ?? [])
        )
    if (dirty) {
      edit.handedBack = true
      const textChanged =
        edit.text !== queuedMessageEditableText(edit.body) ||
        JSON.stringify(pickedSkillsInText(edit.text, inputs.skills)) !==
          JSON.stringify(
            pickedSkillsInText(queuedMessageEditableText(edit.body) ?? '', edit.body.skills ?? [])
          )
      const text = textChanged
        ? stripSentImagePromptMarkers(edit.text, queuedEditKeptImages(edit.body).length)
        : ''
      if (edit.destination) {
        setMobileNativeChatDraftText(edit.destination, (before) =>
          appendReturnedDraftText(before, text)
        )
      } else {
        edit.handBackText?.(text)
      }
      closeMobileNativeChatEditInputs(edit.scopeKey, edit.destination ?? undefined)
      notice?.('Your edit is in the chat box.')
    } else {
      closeMobileNativeChatEditInputs(edit.scopeKey, edit.destination ?? undefined)
    }
  } else {
    closeMobileNativeChatEditInputs(edit.scopeKey)
  }
}

export function serializeMobileQueuedEdit(
  edit: MobileQueuedEditDraft,
  imagesCapable = false,
  skillsCapable = false
) {
  const inputs = readMobileNativeChatDraftInputs(edit.scopeKey)
  return {
    text: nativeChatTextWithFileReferences(
      edit.text,
      inputs.files.flatMap(({ path }) => (path ? [{ path }] : []))
    ),
    ...(imagesCapable
      ? {
          images: inputs.images.map(
            (image) =>
              queuedEditKeptImages(edit.body).find(({ id }) => id === image.id)?.block ?? {
                type: 'image-ref' as const,
                path: image.path
              }
          )
        }
      : {}),
    ...(skillsCapable ? { skills: pickedSkillsInText(edit.text, inputs.skills) } : {})
  }
}

export function removeMobileQueuedEditImage(edit: MobileQueuedEditDraft, id: string): void {
  const images = readMobileNativeChatDraftInputs(edit.scopeKey).images
  const kept = images.filter((image) => image.id !== id)
  edit.text = queuedEditTextForKeptImages(
    edit.text,
    images.map(({ id }) => id),
    kept.map(({ id }) => id)
  )
  updateMobileNativeChatDraftInputs(edit.scopeKey, (current) => ({
    ...current,
    images: kept
  }))
}

export function mobileQueuedEditSaveHeld(
  edit: MobileQueuedEditDraft,
  imagesCapable = false
): boolean {
  const inputs = readMobileNativeChatDraftInputs(edit.scopeKey)
  return (
    (inputs.pending ?? 0) > 0 ||
    inputs.files.some(({ path }) => path === null) ||
    (!imagesCapable &&
      inputs.images.map(({ id }) => id).join() !==
        queuedEditKeptImages(edit.body)
          .map(({ id }) => id)
          .join())
  )
}

export function seedMobileQueuedEditInputs(
  scopeKey: string,
  body: AgentSessionQueuedMessage['body']
): void {
  updateMobileNativeChatDraftInputs(scopeKey, () => ({
    skills: body.skills ?? [],
    files: [],
    images: queuedEditKeptImages(body).map(({ id, block }) => ({
      id,
      path: block.path ?? block.url ?? '',
      previewUri: block.url ?? block.path ?? ''
    }))
  }))
}

export function retainMobileQueuedEditAfterSubmission(edit: MobileQueuedEditDraft): void {
  const sent = edit.submitted
  if (sent) {
    const current = readMobileNativeChatDraftInputs(edit.scopeKey)
    const left = textLeftAfterSubmission(edit.text, sent.text)
    const changedSkills =
      edit.text === sent.text &&
      JSON.stringify(pickedSkillsInText(edit.text, current.skills)) !==
        JSON.stringify(pickedSkillsInText(sent.text, sent.inputs.skills))
    if (left && !changedSkills) {
      edit.text = left.text
    }
    const files = new Set(sent.inputs.files.map(({ id }) => id))
    updateMobileNativeChatDraftInputs(edit.scopeKey, (inputs) => ({
      ...inputs,
      images: inputs.images.filter(
        ({ id }) => !sent.inputs.images.some((image) => image.id === id)
      ),
      files: inputs.files.filter(({ id }) => !files.has(id)),
      skills: pickedSkillsInText(edit.text, inputs.skills)
    }))
  } else {
    edit.text = ''
    updateMobileNativeChatDraftInputs(edit.scopeKey, (inputs) => ({
      ...inputs,
      images: [],
      files: [],
      skills: []
    }))
  }
  edit.body = { ...edit.body, blocks: [], skills: undefined }
}

export function insertMobileQueuedEditDictation(
  edit: MobileQueuedEditDraft,
  destination: MobileNativeChatDraftDestination,
  text: string
): boolean {
  if (!destination.active) {
    return false
  }
  if (destination.scope !== edit.scopeKey) {
    setMobileNativeChatDraftText(destination.scope, (before) =>
      appendBufferedDictation(before, text)
    )
  } else {
    edit.text = appendBufferedDictation(edit.text, text)
  }
  return true
}

export type MobileStructuredQueuedEditArgs = {
  sessionKey: string
  sessionId: string | null
  client: RpcClient | null
  chatActive: boolean
  enabled: boolean
  imagesCapable?: boolean
  skillsCapable?: boolean
  composerScopeKey?: string | null
  messages: readonly AgentSessionQueuedMessage[] | null
  submissions?: readonly AgentJournalSubmission[]
  cards: readonly MobileQueuedMessageCard[]
  mutate: MobileStructuredAgentMutate
  appendComposerText: ((text: string) => boolean) | undefined
  onQueuedEditNotice?: (text: string) => void
  onSendError: (text: string) => void
  onActionResolved?: () => void
}

export function mobileQueuedEditSubmissionPublished(
  edit: MobileQueuedEditDraft,
  message: AgentSessionQueuedMessage | undefined,
  submissions: readonly AgentJournalSubmission[] | undefined
): boolean {
  const fingerprint = edit.submitted?.fingerprint
  return Boolean(
    fingerprint &&
    ((message && agentSessionSendBodyFingerprint(edit.sessionId, message.body) === fingerprint) ||
      submissions?.some(
        (entry) =>
          entry.queuedMessageId === edit.messageId && entry.payloadFingerprint === fingerprint
      ))
  )
}
