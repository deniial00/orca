/**
 * `worktree create --agent`: the worktree and its agent in one `agent.launch`, so the agent follows
 * `--surface`, else the user's Chat UI setting, like every other launch. A host older than
 * `agent.launch` gets the create's own startup terminal, which cannot take a model, effort or surface.
 */

import type { RuntimeWorktreeCreateResult, RuntimeWorktreeRecord } from '../../shared/runtime-types'
import {
  AGENT_LAUNCH_LOCAL_PRESENTATION_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY
} from '../../shared/agent-launch-runtime-capability'
import {
  callAgentLaunch,
  formatAgentLaunch,
  hasLaunchModelFlags,
  getAgentLaunchCapabilities,
  readCliAgentLaunch,
  rejectDefaultAgentRetry,
  resolveCliAgent,
  type CliAgentLaunch,
  type CliAgentLaunchResult,
  type CliAgentRequest,
  type CliLaunchedAgent,
  SURFACE_UNSUPPORTED_MESSAGE,
  withLaunchedAgent
} from '../agent-launch-request'
import type { CliRepoTarget } from '../worktree-project-target'
import { formatWorktreeShow, printResult } from '../format'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { printLineageSummary } from './worktree-lineage-summary'
import { printHookWarning } from './worktree-removal-warnings'
import { withSetupDecisionRecovery } from './worktree-setup-decision-recovery'
import { withCliAgentLaunchRecovery } from '../agent-launch-recovery'

type WorktreeAgentLaunchResult = Pick<
  RuntimeWorktreeCreateResult,
  'lineage' | 'workspaceLineage'
> & {
  /** Absent only when the host could not show the worktree it just created. */
  worktree?: RuntimeWorktreeRecord
  launch: CliAgentLaunchResult
}

type WorktreeCreateAgentRequest = { request: CliAgentRequest; explicitLaunch?: CliAgentLaunch }

/** Reads a named agent's launch before any request, so a bad prompt, model or effort creates
 *  nothing. `default` waits for the host to name the agent; it is still read before the create. */
export function readWorktreeCreateAgentRequest(
  flags: Map<string, string | boolean>,
  request: CliAgentRequest | undefined
): WorktreeCreateAgentRequest | undefined {
  if (!request) {
    return undefined
  }
  rejectDefaultAgentRetry(flags, request)
  return request === 'default'
    ? { request }
    : { request, explicitLaunch: readCliAgentLaunch(flags, request, { createsWorktree: true }) }
}

/** Resolves `--agent default` on the host the repo is set up on, before the worktree exists. */
export async function resolveWorktreeCreateAgent(
  client: RuntimeClient,
  flags: Map<string, string | boolean>,
  pending: WorktreeCreateAgentRequest | undefined,
  repoTarget: CliRepoTarget
): Promise<{ launch: CliAgentLaunch; launchedAgent: CliLaunchedAgent } | undefined> {
  if (!pending) {
    return undefined
  }
  const launchedAgent = await resolveCliAgent(client, pending.request, {
    kind: 'create-worktree',
    ...repoTarget
  })
  const launch =
    pending.explicitLaunch ??
    readCliAgentLaunch(flags, launchedAgent.agent, { createsWorktree: true })
  return { launch, launchedAgent }
}

export async function createWorktreeWithAgent(args: {
  client: RuntimeClient
  flags: Map<string, string | boolean>
  create: Record<string, unknown>
  launch: CliAgentLaunch
  launchedAgent: CliLaunchedAgent
  json: boolean
  rawArgs?: readonly string[]
}): Promise<void> {
  const { client, flags, create, launch, launchedAgent, json, rawArgs } = args
  const capabilities = await getAgentLaunchCapabilities(client)
  if (
    !capabilities?.includes(AGENT_LAUNCH_LOCAL_PRESENTATION_RUNTIME_CAPABILITY) ||
    (launch.prompt && !capabilities.includes(AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY))
  ) {
    if (launch.operationId) {
      throw new RuntimeClientError(
        'agent_session_operation_unknown',
        'This host cannot replay the earlier launch. Return to the original execution host; do not retry without --retry-launch.'
      )
    }
    if (hasLaunchModelFlags(flags)) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca host cannot start an agent on a chosen model or effort. Update Orca on the execution host, or omit --model and --effort.'
      )
    }
    if (launch.surface) {
      throw new RuntimeClientError('incompatible_runtime', SURFACE_UNSUPPORTED_MESSAGE)
    }
    const params = {
      ...create,
      startupAgent: launch.agent,
      startupPrompt: launch.prompt?.text ?? '',
      launchSource: 'cli'
    }
    const created = await withSetupDecisionRecovery(
      withCliAgentLaunchRecovery(
        client.call<RuntimeWorktreeCreateResult>('worktree.create', params),
        {
          rawArgs,
          params
        }
      )
    )
    printHookWarning(created.result, json)
    printLineageSummary(created.result, json)
    printResult(created, json, formatWorktreeShow)
    return
  }
  const launched = await withSetupDecisionRecovery(
    callAgentLaunch(
      client,
      launch,
      {
        target: { kind: 'create-worktree', create },
        presentation: create.activate === true ? 'focused' : 'background'
      },
      capabilities,
      rawArgs
    ),
    launch.operationId !== undefined
  )
  const worktree = await showLaunchedWorktree(client, launched.result.worktreeId)
  const result: WorktreeAgentLaunchResult = {
    ...(worktree
      ? {
          worktree,
          lineage: worktree.lineage,
          workspaceLineage: worktree.workspaceLineage ?? null
        }
      : { lineage: null }),
    launch: withLaunchedAgent(launched.result, launchedAgent)
  }
  printLineageSummary(result, json)
  printResult({ ...launched, result }, json, (value) =>
    [
      ...(value.worktree ? [formatWorktreeShow({ worktree: value.worktree })] : []),
      formatAgentLaunch(value.launch)
    ].join('\n')
  )
}

/** Reporting, never a reason to fail: the agent already runs, and a retry would start a second. */
async function showLaunchedWorktree(
  client: RuntimeClient,
  worktreeId: string
): Promise<RuntimeWorktreeRecord | undefined> {
  try {
    const shown = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree: `id:${worktreeId}`
    })
    return shown.result.worktree
  } catch {
    return undefined
  }
}
