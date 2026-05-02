import { randomUUID } from "node:crypto";
import { spawn as childSpawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  createSdkMcpServer,
  query,
  tool,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  proposeFailingTestsArgsSchema,
  requestAcClarificationArgsSchema,
  SPEC_TOOL_NAMES,
} from "./tools.js";
import type {
  SpecAgentClient,
  SpecAgentDecision,
  SpecAgentRunOptions,
  SpecAgentSession,
} from "./agent.js";

// Default `SpecAgentClient` backed by the Claude Agent SDK. The SDK spawns the
// Claude Code subprocess; the two custom tools live in an in-process MCP
// server. The session iterates over `query()`'s message stream and converts
// terminal events (tool call or end-of-turn-without-tool-call) into a
// `SpecAgentDecision` for the activity.

const PROPOSE_TOOL_DESCRIPTION =
  "Submit one or more new failing test files that capture the ticket's acceptance criteria. The orchestrator writes them, runs the suite, and commits each as a separate commit if at least one fails.";

const CLARIFY_TOOL_DESCRIPTION =
  "Surface that the ticket's acceptance criteria are too ambiguous to translate into tests. The orchestrator opens a Linear sub-ticket with your questions and the workflow pauses for human input.";

const PROPOSE_TOOL_ACK =
  "Submission received. The orchestrator will verify the tests outside this conversation.";

const CLARIFY_TOOL_ACK =
  "Clarification received. The orchestrator will open a sub-ticket outside this conversation.";

class SdkSpecAgentSession implements SpecAgentSession {
  private readonly inputQueue: SDKUserMessage[] = [];
  private inputResolver: (() => void) | null = null;
  private inputDone = false;
  private querying: Query | null = null;
  private pumping: Promise<void> | null = null;
  private firstSent = false;

  // Resolved by either a tool handler or the pump when a turn ends.
  private pendingResolve: ((d: SpecAgentDecision) => void) | null = null;
  // Decision queued before next() was called.
  private bufferedDecision: SpecAgentDecision | null = null;

  constructor(private readonly options: SpecAgentRunOptions) {}

  start(): void {
    probeCliBinary();

    const mcpServer = this.buildMcpServer();
    const inputStream = this.makeInputStream();

    const q = query({
      prompt: inputStream,
      options: {
        cwd: this.options.cwd,
        abortController: makeAbortController(this.options.signal),
        systemPrompt: this.options.systemPrompt,
        mcpServers: { "the-furnace-spec": mcpServer },
        // Read-only built-in tools only — file writes go via our custom tool.
        tools: ["Read", "Glob", "Grep", "Bash"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        settingSources: [],
        // Forward the spawned Claude Code CLI's stderr to our log so spawn
        // failures (auth missing, runtime mismatch, etc.) are diagnosable.
        // Without this, ProcessTransport silences child stderr and we only
        // see the downstream "not ready for writing" error.
        stderr: (chunk) => {
          process.stderr.write(`[claude-cli] ${chunk}`);
        },
        // Force SDK-internal debug logging (spawn cmd + exit code + lifecycle
        // events get written via logForSdkDebugging). Combined with
        // stdio:"pipe", this gives us the child's own stderr too.
        env: { ...process.env, DEBUG_CLAUDE_AGENT_SDK: "1" },
        // Diagnostic: intercept the SDK's spawn so we see the exact command
        // and args, plus a fully captured exit/output trail. Without this,
        // ProcessTransport silently swallows the child's lifecycle.
        spawnClaudeCodeProcess: (opts) => {
          process.stderr.write(
            `[cli-spawn] command=${opts.command}\n[cli-spawn] args=${JSON.stringify(opts.args)}\n[cli-spawn] cwd=${opts.cwd ?? "<inherited>"}\n`,
          );
          const child = childSpawn(opts.command, opts.args, {
            cwd: opts.cwd,
            env: opts.env,
            signal: opts.signal,
            stdio: ["pipe", "pipe", "pipe"],
          });
          child.stderr?.on("data", (d: Buffer) => {
            process.stderr.write(`[cli-spawn stderr] ${d.toString()}`);
          });
          child.on("error", (err) => {
            process.stderr.write(`[cli-spawn error] ${err.message}\n`);
          });
          child.on("exit", (code, signal) => {
            process.stderr.write(
              `[cli-spawn exit] code=${code} signal=${signal ?? "<none>"}\n`,
            );
          });
          return child;
        },
      },
    });
    this.querying = q;

    this.pumping = this.pump(q).catch((error) => {
      this.deliver({
        type: "malformed_tool_call",
        tool: "<sdk>",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async next(correctiveMessage?: string): Promise<SpecAgentDecision> {
    if (!this.firstSent) {
      this.firstSent = true;
      // Drop any decision the SDK queued before the first user message arrived.
      this.bufferedDecision = null;
      this.enqueue(this.options.userPrompt);
    } else {
      if (!correctiveMessage) {
        throw new Error("next() called without correctiveMessage after the first turn");
      }
      // Discard a leftover decision (e.g. an unsolicited no_tool_call from
      // the model's wrap-up turn): the corrective message is asking for a
      // *new* answer.
      this.bufferedDecision = null;
      this.enqueue(correctiveMessage);
    }

    return new Promise<SpecAgentDecision>((resolve) => {
      if (this.bufferedDecision) {
        const buffered = this.bufferedDecision;
        this.bufferedDecision = null;
        resolve(buffered);
        return;
      }
      this.pendingResolve = resolve;
    });
  }

  async close(): Promise<void> {
    this.inputDone = true;
    this.inputResolver?.();
    this.inputResolver = null;
    if (this.querying) {
      try {
        await this.querying.interrupt();
      } catch {
        // Already finished.
      }
    }
    if (this.pumping) {
      await this.pumping.catch(() => {});
    }
  }

  private deliver(decision: SpecAgentDecision): void {
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(decision);
    } else {
      this.bufferedDecision = decision;
    }
  }

  private enqueue(text: string): void {
    this.inputQueue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: randomUUID(),
    });
    this.inputResolver?.();
    this.inputResolver = null;
  }

  private buildMcpServer() {
    const proposeTool = tool(
      SPEC_TOOL_NAMES.proposeFailingTests,
      PROPOSE_TOOL_DESCRIPTION,
      proposeFailingTestsArgsSchema.shape,
      async (args) => {
        const parsed = proposeFailingTestsArgsSchema.safeParse(args);
        if (!parsed.success) {
          this.deliver({
            type: "malformed_tool_call",
            tool: SPEC_TOOL_NAMES.proposeFailingTests,
            error: parsed.error.message,
          });
          return {
            content: [{ type: "text", text: `invalid arguments: ${parsed.error.message}` }],
            isError: true,
          };
        }
        this.deliver({ type: "propose_failing_tests", input: parsed.data });
        return { content: [{ type: "text", text: PROPOSE_TOOL_ACK }] };
      },
    );

    const clarifyTool = tool(
      SPEC_TOOL_NAMES.requestAcClarification,
      CLARIFY_TOOL_DESCRIPTION,
      requestAcClarificationArgsSchema.shape,
      async (args) => {
        const parsed = requestAcClarificationArgsSchema.safeParse(args);
        if (!parsed.success) {
          this.deliver({
            type: "malformed_tool_call",
            tool: SPEC_TOOL_NAMES.requestAcClarification,
            error: parsed.error.message,
          });
          return {
            content: [{ type: "text", text: `invalid arguments: ${parsed.error.message}` }],
            isError: true,
          };
        }
        this.deliver({ type: "request_ac_clarification", input: parsed.data });
        return { content: [{ type: "text", text: CLARIFY_TOOL_ACK }] };
      },
    );

    return createSdkMcpServer({
      name: "the-furnace-spec",
      version: "0.0.1",
      tools: [proposeTool, clarifyTool],
    });
  }

  private makeInputStream(): AsyncIterable<SDKUserMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        return {
          async next(): Promise<IteratorResult<SDKUserMessage>> {
            while (self.inputQueue.length === 0 && !self.inputDone) {
              await new Promise<void>((resolve) => {
                self.inputResolver = resolve;
              });
            }
            if (self.inputQueue.length === 0) {
              return { value: undefined, done: true };
            }
            const value = self.inputQueue.shift()!;
            return { value, done: false };
          },
        };
      },
    };
  }

  private async pump(q: Query): Promise<void> {
    let assistantTurnHadToolCall = false;
    for await (const message of q as AsyncIterable<SDKMessage>) {
      if (message.type === "assistant") {
        const blocks = message.message.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (
              typeof block === "object" &&
              block !== null &&
              (block as { type?: string }).type === "tool_use"
            ) {
              assistantTurnHadToolCall = true;
            }
          }
        }
        const stopReason = message.message.stop_reason;
        // If the assistant ended a turn without invoking a tool, treat that as
        // a no_tool_call decision so the activity can nudge it.
        if (stopReason && stopReason !== "tool_use" && !assistantTurnHadToolCall) {
          this.deliver({ type: "no_tool_call" });
        }
        if (stopReason && stopReason !== "tool_use") {
          assistantTurnHadToolCall = false;
        }
      } else if (message.type === "result") {
        if (this.pendingResolve) {
          this.deliver({ type: "no_tool_call" });
        }
        break;
      }
    }
  }
}

// Diagnostic probe: spawns the bundled Claude Code cli.js with `--version`
// SYNCHRONOUSLY, so its stdout/stderr/exit are captured before the SDK's
// ProcessTransport runs and (currently) crashes the worker. Without this we
// only see the downstream "ProcessTransport is not ready for writing" error.
function probeCliBinary(): void {
  try {
    const req = createRequire(import.meta.url);
    const cliPath = req.resolve("@anthropic-ai/claude-agent-sdk/cli.js");
    process.stderr.write(`[cli-probe] resolved cli.js -> ${cliPath}\n`);
    const result = spawnSync(process.execPath, [cliPath, "--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    if (result.error) {
      process.stderr.write(`[cli-probe error] ${result.error.message}\n`);
    }
    if (result.stdout && result.stdout.length > 0) {
      process.stderr.write(`[cli-probe stdout] ${result.stdout.toString()}`);
    }
    if (result.stderr && result.stderr.length > 0) {
      process.stderr.write(`[cli-probe stderr] ${result.stderr.toString()}`);
    }
    process.stderr.write(
      `[cli-probe exit] status=${result.status} signal=${result.signal ?? "<none>"}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[cli-probe] failed to spawn: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

function makeAbortController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller;
}

export class SdkSpecAgentClient implements SpecAgentClient {
  async startSession(options: SpecAgentRunOptions): Promise<SpecAgentSession> {
    const session = new SdkSpecAgentSession(options);
    session.start();
    return session;
  }
}

export const defaultSpecAgentClient: SpecAgentClient = new SdkSpecAgentClient();
