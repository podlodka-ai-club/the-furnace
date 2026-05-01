import { randomUUID } from "node:crypto";
import {
  createSdkMcpServer,
  query,
  tool,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { reportAttemptResultArgsSchema, CODER_TOOL_NAMES } from "./tools.js";
import type {
  CoderAgentClient,
  CoderAgentDecision,
  CoderAgentRunOptions,
  CoderAgentSession,
} from "./agent.js";

class SdkCoderAgentSession implements CoderAgentSession {
  private readonly inputQueue: SDKUserMessage[] = [];
  private inputResolver: (() => void) | null = null;
  private inputDone = false;
  private querying: Query | null = null;
  private pumping: Promise<void> | null = null;
  private firstSent = false;
  private pendingResolve: ((d: CoderAgentDecision) => void) | null = null;
  private bufferedDecision: CoderAgentDecision | null = null;

  constructor(private readonly options: CoderAgentRunOptions) {}

  start(): void {
    const mcpServer = this.buildMcpServer();
    const q = query({
      prompt: this.makeInputStream(),
      options: {
        cwd: this.options.cwd,
        abortController: makeAbortController(this.options.signal),
        systemPrompt: this.options.systemPrompt,
        mcpServers: { "the-furnace-coder": mcpServer },
        tools: ["Read", "Glob", "Grep", "Bash", "Edit", "Write"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        settingSources: [],
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

  async next(correctiveMessage?: string): Promise<CoderAgentDecision> {
    if (!this.firstSent) {
      this.firstSent = true;
      this.bufferedDecision = null;
      this.enqueue(this.options.userPrompt);
    } else {
      if (!correctiveMessage) throw new Error("next() called without correctiveMessage after first turn");
      this.bufferedDecision = null;
      this.enqueue(correctiveMessage);
    }

    return await new Promise<CoderAgentDecision>((resolve) => {
      if (this.bufferedDecision) {
        const d = this.bufferedDecision;
        this.bufferedDecision = null;
        resolve(d);
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
        // noop
      }
    }
    if (this.pumping) await this.pumping.catch(() => {});
  }

  private deliver(decision: CoderAgentDecision): void {
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
    const report = tool(
      CODER_TOOL_NAMES.reportAttemptResult,
      "Report the attempt result with one of: success, retry, dep-missing, design-question.",
      reportAttemptResultArgsSchema.shape,
      async (args) => {
        const parsed = reportAttemptResultArgsSchema.safeParse(args);
        if (!parsed.success) {
          this.deliver({
            type: "malformed_tool_call",
            tool: CODER_TOOL_NAMES.reportAttemptResult,
            error: parsed.error.message,
          });
          return {
            content: [{ type: "text", text: `invalid arguments: ${parsed.error.message}` }],
            isError: true,
          };
        }
        this.deliver({ type: "report_attempt_result", input: parsed.data });
        return { content: [{ type: "text", text: "Result accepted." }] };
      },
    );

    return createSdkMcpServer({ name: "the-furnace-coder", version: "0.0.1", tools: [report] });
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
            if (self.inputQueue.length === 0) return { value: undefined, done: true };
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
            if (typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_use") {
              assistantTurnHadToolCall = true;
            }
          }
        }
        const stopReason = message.message.stop_reason;
        if (stopReason && stopReason !== "tool_use" && !assistantTurnHadToolCall) {
          this.deliver({ type: "no_tool_call" });
        }
        if (stopReason && stopReason !== "tool_use") {
          assistantTurnHadToolCall = false;
        }
      } else if (message.type === "result") {
        if (this.pendingResolve) this.deliver({ type: "no_tool_call" });
        break;
      }
    }
  }
}

function makeAbortController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

class SdkCoderAgentClient implements CoderAgentClient {
  async startSession(options: CoderAgentRunOptions): Promise<CoderAgentSession> {
    const session = new SdkCoderAgentSession(options);
    session.start();
    return session;
  }
}

export const defaultCoderAgentClient: CoderAgentClient = new SdkCoderAgentClient();
