import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";

import type { AgentSessionConfig } from "../../agent-sdk-types.js";
import { FakePi } from "../pi/test-utils/fake-pi.js";
import { OmpRpcAgentClient } from "./agent.js";

function createClientWithOmpAgentDir(agentDir: string): OmpRpcAgentClient {
  return new OmpRpcAgentClient({
    logger: pino({ level: "silent" }),
    runtime: new FakePi(),
    runtimeSettings: { env: { OMP_CODING_AGENT_DIR: agentDir } },
  });
}

function createClient(pi = new FakePi(["omp"])): OmpRpcAgentClient {
  return new OmpRpcAgentClient({
    logger: pino({ level: "silent" }),
    runtime: pi,
  });
}

function createConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    provider: "omp",
    cwd: "/tmp/paseo-omp-rpc-test",
    ...overrides,
  };
}

describe("OmpRpcAgentClient", () => {
  test("identifies itself with the omp provider id", () => {
    const client = new OmpRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: new FakePi(),
    });
    expect(client.provider).toBe("omp");
  });

  test("creates a session that reports the omp provider", async () => {
    const client = new OmpRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: new FakePi(),
    });

    const session = await client.createSession(createConfig());
    expect(session.provider).toBe("omp");
    await session.close();
  });

  test("lists OMP approval modes", async () => {
    await expect(createClient().listModes({ cwd: "/tmp/project", force: false })).resolves.toEqual([
      {
        id: "always-ask",
        label: "Always Ask",
        description: "Auto-approves read-only tools and prompts for writes or command execution",
      },
      {
        id: "write",
        label: "Write",
        description:
          "Auto-approves read and workspace-write tools, then prompts for command execution",
      },
      {
        id: "yolo",
        label: "YOLO",
        description: "Auto-approves all OMP tool calls",
      },
    ]);
  });

  test("launches OMP with the selected approval mode", async () => {
    const pi = new FakePi(["omp"]);
    const client = createClient(pi);

    await client.createSession(createConfig({ modeId: "write" }));

    const actualLaunch = pi.recordedLaunches[0]!;
    expect(actualLaunch.extensionPaths).toHaveLength(1);
    expect(actualLaunch.argv).toEqual([
      "omp",
      "--mode",
      "rpc",
      "--thinking",
      "medium",
      "--approval-mode",
      "write",
      "--extension",
      actualLaunch.extensionPaths[0],
    ]);
  });

  test("defaults OMP approval mode to yolo", async () => {
    const pi = new FakePi(["omp"]);
    const client = createClient(pi);
    const session = await client.createSession(createConfig());

    expect(await session.getCurrentMode()).toBe("yolo");
    expect(pi.recordedLaunches[0]?.argv).toContain("yolo");
  });

  test("updates OMP approval mode through RPC when switching modes", async () => {
    const pi = new FakePi(["omp"]);
    const client = createClient(pi);
    const session = await client.createSession(createConfig({ modeId: "always-ask" }));

    await session.setMode("write");

    expect(await session.getCurrentMode()).toBe("write");
    expect(pi.recordedLaunches).toHaveLength(1);
    expect(pi.latestSession().setApprovalModeRequests).toEqual(["write"]);
  });

  test("falls back to restarting OMP when RPC approval mode switching is unsupported", async () => {
    const pi = new FakePi(["omp"]);
    const client = createClient(pi);
    const session = await client.createSession(createConfig({ modeId: "always-ask" }));
    pi.latestSession().setApprovalModeError = new Error(
      "Pi RPC request timed out for set_approval_mode",
    );

    await session.setMode("write");

    expect(await session.getCurrentMode()).toBe("write");
    expect(pi.recordedLaunches).toHaveLength(2);
    const restartLaunch = pi.recordedLaunches[1]!;
    expect(restartLaunch.extensionPaths).toHaveLength(1);
    expect(restartLaunch.argv).toEqual([
      "omp",
      "--mode",
      "rpc",
      "--thinking",
      "medium",
      "--approval-mode",
      "write",
      "--session",
      "/tmp/pi-session",
      "--extension",
      restartLaunch.extensionPaths[0],
    ]);
  });

  test("rejects invalid OMP approval modes", async () => {
    const session = await createClient().createSession(createConfig({ modeId: "write" }));

    await expect(session.setMode("invalid")).rejects.toThrow(
      'Invalid OMP mode "invalid". Valid modes are: always-ask, write, yolo',
    );
  });

  test("lists persisted OMP sessions from the configured OMP agent directory", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-omp-client-"));
    const cwd = path.join(root, "workspace");
    const agentDir = path.join(root, "agent");
    const sessionsDir = path.join(agentDir, "sessions", "--workspace--");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "20260101_session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "omp-session",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd,
        }),
        JSON.stringify({
          type: "message",
          id: "entry-1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "remember this" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const client = createClientWithOmpAgentDir(agentDir);

    await expect(client.listPersistedAgents({ cwd })).resolves.toMatchObject([
      {
        provider: "omp",
        sessionId: "omp-session",
        cwd,
        persistence: {
          provider: "omp",
          sessionId: "omp-session",
          nativeHandle: sessionFile,
          metadata: { provider: "omp", cwd },
        },
        timeline: [{ type: "user_message", text: "remember this" }],
      },
    ]);
  });

  test("ignores PI_CODING_AGENT_DIR when running as the OMP provider", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-omp-isolation-"));
    const cwd = path.join(root, "workspace");
    const piAgentDir = path.join(root, "pi-agent");
    const ompAgentDir = path.join(root, "omp-agent");
    const piSessionsDir = path.join(piAgentDir, "sessions");
    const ompSessionsDir = path.join(ompAgentDir, "sessions");
    mkdirSync(piSessionsDir, { recursive: true });
    mkdirSync(ompSessionsDir, { recursive: true });

    const sessionRecord = (id: string) =>
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd,
        }),
        JSON.stringify({
          type: "message",
          id: "entry-1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: id },
        }),
      ].join("\n") + "\n";
    writeFileSync(path.join(piSessionsDir, "pi.jsonl"), sessionRecord("pi-only"), "utf8");
    writeFileSync(path.join(ompSessionsDir, "omp.jsonl"), sessionRecord("omp-only"), "utf8");

    const client = new OmpRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: new FakePi(),
      runtimeSettings: {
        env: {
          PI_CODING_AGENT_DIR: piAgentDir,
          OMP_CODING_AGENT_DIR: ompAgentDir,
        },
      },
    });

    const descriptors = await client.listPersistedAgents({ cwd });
    expect(descriptors.map((d) => d.sessionId)).toEqual(["omp-only"]);
  });
});
