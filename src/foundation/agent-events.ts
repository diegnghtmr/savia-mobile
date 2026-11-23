import { uuid } from "./workspace-context";

type AgentAnswer = { status: "completed"; text: string; needsApproval: boolean; approvalId: string | null };
export type AgentRunResult = AgentAnswer | { status: "failed"; message: string | null };
export async function readAgentEvents(response: { headers: Headers; body?: ReadableStream<Uint8Array> | null }): Promise<AgentRunResult> {
  if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body) throw new TypeError();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const answer: AgentAnswer = { status: "completed", text: "", needsApproval: false, approvalId: null };
  let pending = "", bytes = 0, run: string | null = null;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done || (bytes += chunk.value.byteLength) > 256 * 1024) throw new TypeError();
      const frames = (pending + decoder.decode(chunk.value, { stream: true })).split(/\r?\n\r?\n/);
      pending = frames.pop()!;
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        const event = JSON.parse(data), id = uuid(event?.runId);
        if (!id || (run !== null && run !== id) || typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp))) throw new TypeError();
        run = id;
        switch (event.type) {
          case "run_started": case "tool_proposed": case "tool_completed": break;
          case "text_delta":
            if (typeof event.data?.text !== "string") throw new TypeError();
            answer.text += event.data.text; break;
          case "approval_required":
            answer.needsApproval = true; answer.approvalId = uuid(event.data?.approvalId); break;
          case "run_completed": return answer;
          case "run_failed": return { status: "failed", message: typeof event.data?.message === "string" ? event.data.message : null };
          default: throw new TypeError();
        }
      }
    }
  } finally { void reader.cancel().catch(() => {}); }
}
