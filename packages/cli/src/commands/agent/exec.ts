import { type Command, Option } from "commander";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { lookup } from "mime-types";
import type {
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  AgentStreamMessage,
} from "@getpaseo/protocol/messages";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import { collectMultiple } from "../../utils/command-options.js";
import { parseDuration } from "../../utils/duration.js";
import { resolveProviderAndModel } from "../../utils/provider-model.js";
import type { CommandError } from "../../output/index.js";
import { toCommandError } from "../../output/index.js";

type ConnectedDaemonClient = Awaited<ReturnType<typeof connectToDaemon>>;

export type AgentExecClient = Pick<
  ConnectedDaemonClient,
  "close" | "createAgent" | "fetchAgent" | "on" | "sendAgentMessage" | "waitForFinish"
>;

export type AgentExecMode = "create" | "send";
export type AgentExecFinishStatus = "completed" | "timeout" | "permission" | "error";

export interface AgentExecOptions {
  agent?: string;
  prompt?: string;
  promptFile?: string;
  image?: string[];
  timeout?: string;
  title?: string;
  name?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  mode?: string;
  worktree?: string;
  base?: string;
  cwd?: string;
  env?: string[];
  label?: string[];
  host?: string;
  [key: string]: unknown;
}

export type AgentExecNdjsonEvent =
  | {
      type: "start";
      mode: AgentExecMode;
      agent: AgentSnapshotPayload;
    }
  | {
      type: "event";
      agentId: string;
      timestamp: string;
      seq?: number;
      epoch?: string;
      event: AgentStreamEventPayload;
    }
  | {
      type: "finish";
      agentId: string;
      status: AgentExecFinishStatus;
      agent: AgentSnapshotPayload;
      error: string | null;
      lastMessage: string | null;
    }
  | {
      type: "error";
      code: string;
      message: string;
      details?: unknown;
    };

interface RunAgentExecInput {
  promptArgument: string | undefined;
  options: AgentExecOptions;
  writeEvent: (event: AgentExecNdjsonEvent) => void;
  connect?: () => Promise<AgentExecClient>;
  cwd?: string;
}

type WaitFinishState = Awaited<ReturnType<ConnectedDaemonClient["waitForFinish"]>>;

export function addExecOptions(cmd: Command): Command {
  return cmd
    .description("Create or message an agent, stream NDJSON events, and wait for completion")
    .argument("[prompt]", "The task/message to send")
    .option("--agent <id>", "Send the prompt to an existing agent instead of creating one")
    .option("--prompt <text>", "Provide the prompt inline as a flag")
    .option("--prompt-file <path>", "Read the prompt from a UTF-8 text file")
    .option("--image <path>", "Attach image(s) to the prompt", collectMultiple, [])
    .option("--timeout <duration>", "Maximum time to wait for completion (default: no limit)")
    .option("--title <title>", "Assign a title to a newly created agent")
    .addOption(new Option("--name <name>", "Hidden alias for --title").hideHelp())
    .option(
      "--provider <provider>",
      "Agent provider, or provider/model (e.g. codex or codex/gpt-5.4)",
    )
    .option("--model <model>", "Model to use for a newly created agent")
    .option("--thinking <id>", "Thinking option ID to use for a newly created agent")
    .option("--mode <mode>", "Provider-specific mode for a newly created agent")
    .option("--worktree <name>", "Create the new agent in a git worktree")
    .option("--base <branch>", "Base branch for worktree (default: current branch)")
    .option("--cwd <path>", "Working directory for a newly created agent (default: current)")
    .option(
      "--env <key=value>",
      "Set environment variable(s) for the new agent process (can be used multiple times)",
      collectMultiple,
      [],
    )
    .option(
      "--label <key=value>",
      "Add label(s) to the new agent (can be used multiple times)",
      collectMultiple,
      [],
    );
}

export function writeNdjsonEvent(event: AgentExecNdjsonEvent, write: (line: string) => void): void {
  write(`${JSON.stringify(event)}\n`);
}

export async function resolveExecPromptInput(options: {
  promptArgument: string | undefined;
  promptOption: string | undefined;
  promptFile: string | undefined;
}): Promise<string> {
  const promptText = options.promptArgument?.trim();
  const promptOptionText = options.promptOption?.trim();
  const promptFilePath = options.promptFile?.trim();
  const providedSourceCount = [promptText, promptOptionText, promptFilePath].filter(Boolean).length;

  if (providedSourceCount > 1) {
    throw {
      code: "CONFLICTING_PROMPT_INPUT",
      message: "Provide exactly one of prompt argument, --prompt, or --prompt-file",
    } satisfies CommandError;
  }

  if (promptText) {
    return options.promptArgument as string;
  }

  if (promptOptionText) {
    return options.promptOption as string;
  }

  if (!promptFilePath) {
    throw {
      code: "MISSING_PROMPT",
      message: "A prompt is required",
      details:
        "Usage: paseo agent exec [options] [prompt] | --prompt <text> | --prompt-file <path>",
    } satisfies CommandError;
  }

  try {
    return await readFile(resolve(promptFilePath), "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "PROMPT_FILE_READ_ERROR",
      message: `Failed to read prompt file: ${promptFilePath}`,
      details: message,
    } satisfies CommandError;
  }
}

export function validateExecOptions(options: AgentExecOptions): void {
  if (options.agent) {
    const createOnlyOptions: Array<[keyof AgentExecOptions, string]> = [
      ["provider", "--provider"],
      ["model", "--model"],
      ["thinking", "--thinking"],
      ["mode", "--mode"],
      ["worktree", "--worktree"],
      ["base", "--base"],
      ["cwd", "--cwd"],
      ["title", "--title"],
      ["name", "--name"],
    ];
    const providedCreateOnlyOptions = createOnlyOptions
      .filter(([key]) => hasOptionValue(options[key]))
      .map(([, flag]) => flag);
    if ((options.env?.length ?? 0) > 0) providedCreateOnlyOptions.push("--env");
    if ((options.label?.length ?? 0) > 0) providedCreateOnlyOptions.push("--label");

    if (providedCreateOnlyOptions.length > 0) {
      throw {
        code: "INVALID_OPTIONS",
        message: "Create-only options cannot be used with --agent",
        details: `Remove ${providedCreateOnlyOptions.join(", ")} or omit --agent to create a new agent.`,
      } satisfies CommandError;
    }
    return;
  }

  if (options.base && !options.worktree) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--base can only be used with --worktree",
      details: "Usage: paseo agent exec --worktree <name> --base <branch> <prompt>",
    } satisfies CommandError;
  }

  const thinkingOptionId = options.thinking?.trim();
  if (options.thinking !== undefined && !thinkingOptionId) {
    throw {
      code: "INVALID_THINKING_OPTION",
      message: "--thinking cannot be empty",
      details:
        'Provide a thinking option ID. Use "paseo provider models <provider> --thinking" to list valid IDs.',
    } satisfies CommandError;
  }
}

export function parseExecTimeout(timeout: string | undefined): number {
  if (!timeout) return 0;
  try {
    const ms = parseDuration(timeout);
    if (ms <= 0) {
      throw new Error("Timeout must be positive");
    }
    return ms;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "INVALID_TIMEOUT",
      message: "Invalid timeout value",
      details: message,
    } satisfies CommandError;
  }
}

export function buildFinishEvent(args: {
  state: WaitFinishState;
  fallbackAgent: AgentSnapshotPayload;
}): Extract<AgentExecNdjsonEvent, { type: "finish" }> {
  const agent = args.state.final ?? args.fallbackAgent;
  const status: AgentExecFinishStatus =
    args.state.status === "idle" ? "completed" : args.state.status;
  return {
    type: "finish",
    agentId: agent.id,
    status,
    agent,
    error: args.state.error,
    lastMessage: args.state.lastMessage,
  };
}

export function getExecExitCode(status: AgentExecFinishStatus): number {
  return status === "completed" ? 0 : 1;
}

export async function runAgentExec(input: RunAgentExecInput): Promise<AgentExecFinishStatus> {
  validateExecOptions(input.options);
  const promptInput = await resolveExecPromptInput({
    promptArgument: input.promptArgument,
    promptOption: input.options.prompt,
    promptFile: input.options.promptFile,
  });
  const timeoutMs = parseExecTimeout(input.options.timeout);
  const images = await readImageFiles(input.options.image);
  const host = getDaemonHost({ host: input.options.host });
  const connect = input.connect ?? (() => connectToDaemon({ host: input.options.host }));
  let client: AgentExecClient;
  try {
    client = await connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }

  let unsubscribe: (() => void) | null = null;
  let targetAgentId: string | null = null;
  let startEmitted = false;
  const bufferedMessages: AgentStreamMessage[] = [];

  const handleStreamMessage = (msg: unknown): void => {
    const message = msg as AgentStreamMessage;
    if (message.type !== "agent_stream") return;
    if (targetAgentId && message.payload.agentId !== targetAgentId) return;

    if (!targetAgentId || !startEmitted) {
      bufferedMessages.push(message);
      return;
    }

    input.writeEvent(toExecStreamEvent(message));
  };

  try {
    unsubscribe = client.on("agent_stream", handleStreamMessage);

    const mode: AgentExecMode = input.options.agent ? "send" : "create";
    const startedAgent =
      mode === "send"
        ? await startExistingAgentExec({
            client,
            agentId: input.options.agent as string,
            prompt: promptInput,
            images,
            writeEvent: input.writeEvent,
            setTargetAgentId: (agentId) => {
              targetAgentId = agentId;
            },
            markStartEmitted: () => {
              startEmitted = true;
            },
          })
        : await startCreatedAgentExec({
            client,
            prompt: promptInput,
            images,
            options: input.options,
            cwd: input.cwd ?? process.cwd(),
            writeEvent: input.writeEvent,
            setTargetAgentId: (agentId) => {
              targetAgentId = agentId;
            },
            markStartEmitted: () => {
              startEmitted = true;
            },
            flushBufferedMessages: () => {
              flushBufferedMessages(bufferedMessages, targetAgentId, input.writeEvent);
            },
          });

    const state = await client.waitForFinish(startedAgent.id, timeoutMs);
    const finishEvent = buildFinishEvent({ state, fallbackAgent: startedAgent });
    input.writeEvent(finishEvent);
    return finishEvent.status;
  } finally {
    unsubscribe?.();
    await client.close().catch(() => {});
  }
}

export async function runExecCommand(
  prompt: string | undefined,
  options: AgentExecOptions,
  _command: Command,
): Promise<void> {
  try {
    const status = await runAgentExec({
      promptArgument: prompt,
      options,
      writeEvent: (event) => writeNdjsonEvent(event, (line) => process.stdout.write(line)),
    });
    process.exitCode = getExecExitCode(status);
  } catch (err) {
    const error = toCommandError(err);
    writeNdjsonEvent(
      {
        type: "error",
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
      (line) => process.stdout.write(line),
    );
    process.exitCode = 1;
  }
}

function hasOptionValue(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined;
}

async function readImageFiles(
  imagePaths: string[] | undefined,
): Promise<Array<{ data: string; mimeType: string }> | undefined> {
  if (!imagePaths || imagePaths.length === 0) return undefined;
  return Promise.all(
    imagePaths.map(async (imagePath) => {
      const resolvedPath = resolve(imagePath);
      try {
        const imageData = await readFile(resolvedPath);
        const mimeType = lookup(resolvedPath) || "application/octet-stream";
        if (!mimeType.startsWith("image/")) {
          throw new Error(`File is not an image: ${imagePath} (detected type: ${mimeType})`);
        }
        return {
          data: imageData.toString("base64"),
          mimeType,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw {
          code: "IMAGE_READ_ERROR",
          message: `Failed to read image file: ${imagePath}`,
          details: message,
        } satisfies CommandError;
      }
    }),
  );
}

function toExecStreamEvent(
  message: AgentStreamMessage,
): Extract<AgentExecNdjsonEvent, { type: "event" }> {
  return {
    type: "event",
    agentId: message.payload.agentId,
    timestamp: message.payload.timestamp,
    ...(message.payload.seq === undefined ? {} : { seq: message.payload.seq }),
    ...(message.payload.epoch === undefined ? {} : { epoch: message.payload.epoch }),
    event: message.payload.event,
  };
}

async function startExistingAgentExec(input: {
  client: AgentExecClient;
  agentId: string;
  prompt: string;
  images: Array<{ data: string; mimeType: string }> | undefined;
  writeEvent: (event: AgentExecNdjsonEvent) => void;
  setTargetAgentId: (agentId: string) => void;
  markStartEmitted: () => void;
}): Promise<AgentSnapshotPayload> {
  const fetchResult = await input.client.fetchAgent(input.agentId);
  if (!fetchResult) {
    throw {
      code: "AGENT_NOT_FOUND",
      message: `No agent found matching: ${input.agentId}`,
      details: "Use `paseo agent ls` to list available agents",
    } satisfies CommandError;
  }

  const agent = fetchResult.agent;
  input.setTargetAgentId(agent.id);
  input.writeEvent({ type: "start", mode: "send", agent });
  input.markStartEmitted();
  await input.client.sendAgentMessage(agent.id, input.prompt, { images: input.images });
  return agent;
}

async function startCreatedAgentExec(input: {
  client: AgentExecClient;
  prompt: string;
  images: Array<{ data: string; mimeType: string }> | undefined;
  options: AgentExecOptions;
  cwd: string;
  writeEvent: (event: AgentExecNdjsonEvent) => void;
  setTargetAgentId: (agentId: string) => void;
  markStartEmitted: () => void;
  flushBufferedMessages: () => void;
}): Promise<AgentSnapshotPayload> {
  const resolvedProviderModel = resolveProviderAndModel(input.options);
  const thinkingOptionId = input.options.thinking?.trim();
  const env = parseKeyValueFlags(input.options.env, {
    flagName: "--env",
    code: "INVALID_ENV",
    noun: "environment variable",
    pluralNoun: "Environment variables",
  });
  const labels = parseKeyValueFlags(input.options.label, {
    flagName: "--label",
    code: "INVALID_LABEL",
    noun: "label",
    pluralNoun: "Labels",
  });
  const git = input.options.worktree
    ? {
        createWorktree: true,
        worktreeSlug: input.options.worktree,
        baseBranch: input.options.base,
      }
    : undefined;
  const agent = await input.client.createAgent({
    provider: resolvedProviderModel.provider,
    cwd: input.options.cwd ?? input.cwd,
    title: input.options.title ?? input.options.name,
    modeId: input.options.mode,
    model: resolvedProviderModel.model,
    thinkingOptionId,
    initialPrompt: input.prompt,
    images: input.images,
    env: Object.keys(env).length > 0 ? env : undefined,
    git,
    worktreeName: input.options.worktree,
    labels: Object.keys(labels).length > 0 ? labels : undefined,
  });

  input.setTargetAgentId(agent.id);
  input.writeEvent({ type: "start", mode: "create", agent });
  input.markStartEmitted();
  input.flushBufferedMessages();
  return agent;
}

function flushBufferedMessages(
  bufferedMessages: AgentStreamMessage[],
  targetAgentId: string | null,
  writeEvent: (event: AgentExecNdjsonEvent) => void,
): void {
  if (!targetAgentId) return;
  for (const message of bufferedMessages) {
    if (message.payload.agentId === targetAgentId) {
      writeEvent(toExecStreamEvent(message));
    }
  }
  bufferedMessages.length = 0;
}

function parseKeyValueFlags(
  flags: string[] | undefined,
  options: {
    flagName: string;
    code: CommandError["code"];
    noun: string;
    pluralNoun: string;
  },
): Record<string, string> {
  const values: Record<string, string> = {};
  if (!flags) return values;
  for (const flag of flags) {
    const eqIndex = flag.indexOf("=");
    if (eqIndex === -1) {
      throw {
        code: options.code,
        message: `Invalid ${options.noun} format: ${flag}`,
        details: `${options.pluralNoun} must be in key=value format`,
      } satisfies CommandError;
    }
    values[flag.slice(0, eqIndex)] = flag.slice(eqIndex + 1);
  }
  return values;
}
