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
import { z } from "zod";

// Generic SDK session that drives a Claude Agent SDK conversation with custom
// terminal tools. Both the spec and coder activities consume this — they each
// supply their own decision type and tool schemas.
//
// The session yields a stream of decisions via `next()`. The shared pump
// handles three structural concerns:
//   1. Streaming the user's input to the SDK and collecting the SDK's
//      assistant messages.
//   2. Delivering "no_tool_call" when an assistant turn ends without invoking
//      any custom tool.
//   3. Delivering "malformed_tool_call" when the args fail Zod validation OR
//      when the SDK itself errors out.
// Tool handlers built from the supplied definitions deliver the terminal
// decision variant the consumer asked for.

export type BaseAgentDecisionEnvelope =
  | { type: "no_tool_call" }
  | { type: "malformed_tool_call"; tool: string; error: string };

export interface AgentToolDefinition<TDecision> {
  name: string;
  description: string;
  // Zod object whose `.shape` is forwarded to the SDK's `tool()` factory.
  schema: z.ZodObject<z.ZodRawShape>;
  // Acknowledgement text returned to the model after a successful call. The
  // model never sees the activity's downstream actions; the ack is just enough
  // for it to stop talking.
  ackText: string;
  // Build the terminal decision variant for the consumer. The args are the
  // already-validated output of `schema.parse`.
  toDecision(args: unknown): TDecision;
}

export interface AgentSessionConfig<TDecision> {
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  signal: AbortSignal;
  builtInTools: ReadonlyArray<string>;
  mcpServerName: string;
  toolDefinitions: ReadonlyArray<AgentToolDefinition<TDecision>>;
}

export interface AgentSession<TDecision> {
  next(correctiveMessage?: string): Promise<TDecision>;
  close(): Promise<void>;
}

// Constraint note: `TDecision` must structurally include the variants of
// `BaseAgentDecisionEnvelope` (`no_tool_call` and `malformed_tool_call`); the
// session delivers those when an assistant turn ends without a tool call or
// when the SDK errors mid-stream. TypeScript cannot express "supertype of
// envelope" cleanly, so the relationship is documented and enforced via
// casts at deliver sites — both the spec and coder decision unions include
// those variants.
export class SdkAgentSession<TDecision> implements AgentSession<TDecision> {
  private readonly inputQueue: SDKUserMessage[] = [];
  private inputResolver: (() => void) | null = null;
  private inputDone = false;
  private querying: Query | null = null;
  private pumping: Promise<void> | null = null;
  private firstSent = false;

  private pendingResolve: ((d: TDecision) => void) | null = null;
  private bufferedDecision: TDecision | null = null;

  constructor(private readonly config: AgentSessionConfig<TDecision>) {}

  start(): void {
    probeCliBinary();

    const mcpServer = this.buildMcpServer();
    const inputStream = this.makeInputStream();

    const q = query({
      prompt: inputStream,
      options: {
        cwd: this.config.cwd,
        abortController: makeAbortController(this.config.signal),
        systemPrompt: this.config.systemPrompt,
        mcpServers: { [this.config.mcpServerName]: mcpServer },
        tools: [...this.config.builtInTools],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        settingSources: [],
        stderr: (chunk) => {
          process.stderr.write(`[claude-cli] ${chunk}`);
        },
        env: { ...process.env, DEBUG_CLAUDE_AGENT_SDK: "1" },
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
      } as TDecision);
    });
  }

  async next(correctiveMessage?: string): Promise<TDecision> {
    if (!this.firstSent) {
      this.firstSent = true;
      this.bufferedDecision = null;
      this.enqueue(this.config.userPrompt);
    } else {
      if (!correctiveMessage) {
        throw new Error("next() called without correctiveMessage after the first turn");
      }
      this.bufferedDecision = null;
      this.enqueue(correctiveMessage);
    }

    return new Promise<TDecision>((resolve) => {
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

  private deliver(decision: TDecision): void {
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
    const tools = this.config.toolDefinitions.map((definition) =>
      tool(
        definition.name,
        definition.description,
        definition.schema.shape,
        async (args) => {
          const parsed = definition.schema.safeParse(args);
          if (!parsed.success) {
            this.deliver({
              type: "malformed_tool_call",
              tool: definition.name,
              error: parsed.error.message,
            } as TDecision);
            return {
              content: [{ type: "text", text: `invalid arguments: ${parsed.error.message}` }],
              isError: true,
            };
          }
          this.deliver(definition.toDecision(parsed.data));
          return { content: [{ type: "text", text: definition.ackText }] };
        },
      ),
    );
    return createSdkMcpServer({
      name: this.config.mcpServerName,
      version: "0.0.1",
      tools,
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
        if (stopReason && stopReason !== "tool_use" && !assistantTurnHadToolCall) {
          this.deliver({ type: "no_tool_call" } as TDecision);
        }
        if (stopReason && stopReason !== "tool_use") {
          assistantTurnHadToolCall = false;
        }
      } else if (message.type === "result") {
        if (this.pendingResolve) {
          this.deliver({ type: "no_tool_call" } as TDecision);
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
