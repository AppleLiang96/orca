import type { AgentType } from './agent-status-types'
import type { AgentSessionSlashCommand } from './agent-session-wire'
import {
  isStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionGoalCommand
} from './structured-agent-session-composer'

/** Provider prompt commands remain content; host actions cannot replace a queued body. */
export function queuedMessageEditAcceptsText(
  text: string,
  agent: AgentType,
  reported?: readonly AgentSessionSlashCommand[],
  hostSetsGoals = false
): boolean {
  return !(
    isStructuredAgentSessionComposerCommand(text, agent, reported) ||
    (hostSetsGoals && isStructuredAgentSessionGoalCommand(text)) ||
    /^\/resume(?:\s|$)/i.test(text)
  )
}
