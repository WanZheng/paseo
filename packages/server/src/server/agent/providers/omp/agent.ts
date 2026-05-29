import type { Logger } from "pino";

import type {
  ListPersistedAgentsOptions,
  PersistedAgentDescriptor,
} from "../../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { PiRpcAgentClient } from "../pi/agent.js";
import { OMP_FAMILY } from "../pi/family-config.js";
import type { PiRuntime } from "../pi/runtime.js";

import { listOmpPersistedAgents } from "./session-descriptor.js";

/**
 * OMP (Oh-My-Pi, https://github.com/oh-my-pi/pi-coding-agent) is a downstream
 * fork of Pi that ships its own binary (`omp`), home directory (`~/.omp`), and
 * plugin ecosystem. It preserves Pi's `--mode rpc` wire protocol and JSONL
 * session schema verbatim, so the entire Pi adapter is reused — only family
 * defaults and OMP-specific launch flags differ.
 *
 * Unlike Pi (which uses Paseo-injected `paseo_capture_entries` extensions to
 * track session identity at runtime), OMP sessions started outside Paseo —
 * e.g. via `omp` invoked directly in the terminal — are discovered by reading
 * the JSONL session files on disk. The `omp/session-descriptor.ts` module
 * mirrors the historical Pi descriptor (removed upstream in #1154) but scoped
 * to OMP paths.
 */
export interface OmpRpcAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  runtime?: PiRuntime;
}

export class OmpRpcAgentClient extends PiRpcAgentClient {
  constructor(options: OmpRpcAgentClientOptions) {
    super({ ...options, family: OMP_FAMILY });
  }

  override async listPersistedAgents(
    options?: ListPersistedAgentsOptions,
  ): Promise<PersistedAgentDescriptor[]> {
    return await listOmpPersistedAgents({
      ...options,
      runtimeSettings: this.runtimeSettings,
    });
  }
}
