import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import {
  captureNativeChatEditDraftDestination,
  appendToNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { nativeChatPasteUnavailableNotice } from '@/lib/native-chat-paste-request'

function captureNativeChatPasteDestination(
  scope: string | undefined,
  lifetime: { active: boolean },
  canPaste: () => boolean,
  insertTypedText: (text: string) => boolean,
  setNotice: (notice: string | null) => void
) {
  const destination = scope ? captureNativeChatEditDraftDestination(scope) : undefined
  const canComplete = (): boolean => (destination ? destination.active : canPaste())
  const insertCapturedText = (text: string): void => {
    if (!text || !canComplete()) {
      return
    }
    if (lifetime.active && insertTypedText(text)) {
      return
    }
    if (destination) {
      appendToNativeChatComposerDraft(destination.scopeKey, { text })
    } else {
      setNotice(nativeChatPasteUnavailableNotice())
    }
  }
  const showPasteUnavailable = (): void => {
    if (lifetime.active) {
      setNotice(nativeChatPasteUnavailableNotice())
    }
  }
  return { canComplete, insertCapturedText, showPasteUnavailable }
}

export function useNativeChatPasteDestination(
  scope: string | undefined,
  lifetime: { active: boolean },
  disabled: boolean,
  insertTypedText: (text: string) => boolean,
  setNotice: (notice: string | null) => void
) {
  const disabledRef = useRef(disabled)
  useLayoutEffect(() => {
    disabledRef.current = disabled
  }, [disabled])
  const canPaste = useCallback(() => lifetime.active && !disabledRef.current, [lifetime])
  const captured = useMemo(
    () => captureNativeChatPasteDestination(scope, lifetime, canPaste, insertTypedText, setNotice),
    [scope, lifetime, canPaste, insertTypedText, setNotice]
  )
  return { canPaste, ...captured }
}
