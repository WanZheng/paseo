import { describe, expect, it, vi } from "vitest";
import type { AgentSnapshotPayload, AgentStreamMessage } from "@getpaseo/protocol/messages";
import type { AgentExecClient, AgentExecNdjsonEvent } from "./exec.js";

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(),
  getDaemonHost: vi.fn(() => "local"),
}));

import {
  buildFinishEvent,
  getExecExitCode,
  resolveExecPromptInput,
  runAgentExec,
  validateExecOptions,
  writeNdjsonEvent,
} from "./exec.js";

function agent(overrides: Partial<AgentSnapshotPayload> = {}): AgentSnapshotPayload {
  return {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/project",
    model: null,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    labels: {},
    ...overrides,
  };
}

function streamMessage(agentId: string, text: string): AgentStreamMessage {
  return {
    type: "agent_stream",
    payload: {
      agentId,
      timestamp: "2026-05-29T00:00:01.000Z",
      seq: 7,
      epoch: "epoch-1",
      event: {
        type: "timeline",
        provider: "codex",
        item: {
          type: "assistant_message",
          text,
        },
      },
    },
  };
}

class FakeExecClient implements AgentExecClient {
  readonly handlers = new Set<(message: AgentStreamMessage) => void>();
  readonly close = vi.fn(async () => {});
  readonly createdAgent: AgentSnapshotPayload;
  readonly fetchAgent = vi.fn(async (_agentId: string) => ({
    agent: this.createdAgent,
    project: null,
  }));
  readonly createAgent = vi.fn(async () => this.createdAgent);
  readonly sendAgentMessage = vi.fn(async () => {});
  readonly waitForFinish = vi.fn(async () => ({
    status: "idle" as const,
    final: this.createdAgent,
    error: null,
    lastMessage: "done",
  }));

  constructor(createdAgent = agent()) {
    this.createdAgent = createdAgent;
  }

  readonly on = ((type: string, handler: (message: AgentStreamMessage) => void) => {
    expect(type).toBe("agent_stream");
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }) as AgentExecClient["on"];

  emit(message: AgentStreamMessage): void {
    for (const handler of this.handlers) {
      handler(message);
    }
  }
}

describe("agent exec prompt input", () => {
  it("rejects multiple prompt sources", async () => {
    await expect(
      resolveExecPromptInput({
        promptArgument: "from arg",
        promptOption: "from option",
        promptFile: undefined,
      }),
    ).rejects.toMatchObject({ code: "CONFLICTING_PROMPT_INPUT" });
  });

  it("requires one prompt source", async () => {
    await expect(
      resolveExecPromptInput({
        promptArgument: undefined,
        promptOption: undefined,
        promptFile: undefined,
      }),
    ).rejects.toMatchObject({ code: "MISSING_PROMPT" });
  });
});

describe("agent exec option validation", () => {
  it("rejects create-only options with --agent", () => {
    expect(() =>
      validateExecOptions({
        agent: "agent-1",
        provider: "codex",
        env: ["A=B"],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
      }),
    );
  });
});

describe("agent exec NDJSON", () => {
  it("serializes one event per line", () => {
    const lines: string[] = [];
    writeNdjsonEvent(
      {
        type: "finish",
        agentId: "agent-1",
        status: "completed",
        agent: agent(),
        error: null,
        lastMessage: "done",
      },
      (line) => lines.push(line),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\n$/);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      type: "finish",
      status: "completed",
      agentId: "agent-1",
    });
  });

  it("maps finish states and exit codes", () => {
    const snapshot = agent();
    const completed = buildFinishEvent({
      state: { status: "idle", final: snapshot, error: null, lastMessage: "done" },
      fallbackAgent: snapshot,
    });
    const timeout = buildFinishEvent({
      state: { status: "timeout", final: snapshot, error: null, lastMessage: null },
      fallbackAgent: snapshot,
    });

    expect(completed.status).toBe("completed");
    expect(timeout.status).toBe("timeout");
    expect(getExecExitCode(completed.status)).toBe(0);
    expect(getExecExitCode(timeout.status)).toBe(1);
  });
});

describe("runAgentExec", () => {
  it("flushes create-mode buffered stream events after start", async () => {
    const client = new FakeExecClient();
    client.createAgent.mockImplementationOnce(async () => {
      client.emit(streamMessage(client.createdAgent.id, "hello"));
      return client.createdAgent;
    });
    const events: AgentExecNdjsonEvent[] = [];

    const status = await runAgentExec({
      promptArgument: "do work",
      options: { provider: "codex" },
      connect: async () => client,
      cwd: "/tmp/project",
      writeEvent: (event) => events.push(event),
    });

    expect(status).toBe("completed");
    expect(events.map((event) => event.type)).toEqual(["start", "event", "finish"]);
    expect(events[0]).toMatchObject({ type: "start", mode: "create" });
    expect(events[1]).toMatchObject({
      type: "event",
      agentId: "agent-1",
      seq: 7,
      event: { type: "timeline" },
    });
    expect(client.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        cwd: "/tmp/project",
        initialPrompt: "do work",
      }),
    );
    expect(client.close).toHaveBeenCalled();
  });

  it("sends to an existing agent and streams until timeout finish", async () => {
    const client = new FakeExecClient();
    client.sendAgentMessage.mockImplementationOnce(async () => {
      client.emit(streamMessage(client.createdAgent.id, "during send"));
    });
    client.waitForFinish.mockResolvedValueOnce({
      status: "timeout",
      final: client.createdAgent,
      error: null,
      lastMessage: null,
    });
    const events: AgentExecNdjsonEvent[] = [];

    const status = await runAgentExec({
      promptArgument: "continue",
      options: { agent: "agent" },
      connect: async () => client,
      writeEvent: (event) => events.push(event),
    });

    expect(status).toBe("timeout");
    expect(events.map((event) => event.type)).toEqual(["start", "event", "finish"]);
    expect(events[0]).toMatchObject({ type: "start", mode: "send" });
    expect(events[2]).toMatchObject({ type: "finish", status: "timeout" });
    expect(client.fetchAgent).toHaveBeenCalledWith("agent");
    expect(client.sendAgentMessage).toHaveBeenCalledWith("agent-1", "continue", {
      images: undefined,
    });
  });
});
