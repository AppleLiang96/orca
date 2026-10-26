import { afterEach, expect, it, vi } from 'vitest'
import {
  subscribeMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs,
  closeMobileNativeChatEditInputs,
  resetMobileNativeChatDraftInputsForTests
} from './mobile-native-chat-draft-inputs'

afterEach(resetMobileNativeChatDraftInputsForTests)
it.each([20, 200])(
  'notifies only affected scopes across %i retained input subscribers and retires listeners',
  (count) => {
    const idle = vi.fn()
    const releases = Array.from({ length: count }, (_, index) =>
      subscribeMobileNativeChatDraftInputs(`idle-${index}`, idle)
    )
    const source = vi.fn()
    const destination = vi.fn()
    releases.push(
      subscribeMobileNativeChatDraftInputs('queued-edit:one', source),
      subscribeMobileNativeChatDraftInputs('bottom', destination)
    )
    updateMobileNativeChatDraftInputs('queued-edit:one', (inputs) => ({ ...inputs, pending: 1 }))
    expect(source).toHaveBeenCalledTimes(1)
    expect(idle).not.toHaveBeenCalled()
    closeMobileNativeChatEditInputs('queued-edit:one', 'bottom')
    expect(source).toHaveBeenCalledTimes(2)
    expect(destination).toHaveBeenCalledTimes(1)
    expect(idle).not.toHaveBeenCalled()
    releases.forEach((release) => release())
    updateMobileNativeChatDraftInputs('bottom', (inputs) => ({ ...inputs, pending: 0 }))
    expect(destination).toHaveBeenCalledTimes(1)
  }
)
