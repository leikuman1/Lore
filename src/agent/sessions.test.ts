import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnvironment } from "../config/env.js";
import { createMockModel } from "../models/mock.js";
import { WorkspaceSessions } from "./sessions.js";

const roots: string[] = [];
const managers: WorkspaceSessions[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(model = createMockModel()) {
  const root = await mkdtemp(join(tmpdir(), "lore-session-"));
  roots.push(root);
  const manager = new WorkspaceSessions({
    env: parseEnvironment({ MODEL_PROVIDER: "mock" }),
    model,
    onEvent: vi.fn(),
  });
  managers.push(manager);
  await manager.select(async () => root);
  const id = manager.snapshot().session?.id;
  if (!id) throw new Error("Missing session");
  return { manager, id, root };
}
async function finish(manager: WorkspaceSessions, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (manager.getRun(id).status === "finished") return manager.getRun(id);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Run did not finish");
}

describe("workspace session lifecycle", () => {
  it("carries SDK messages as complete tool groups and trims oldest turns", async () => {
    const model = createMockModel();
    const original = model.doStream;
    const prompts: Parameters<typeof original>[0]["prompt"][] = [];
    model.doStream = async (call) => {
      prompts.push(call.prompt);
      return original(call);
    };
    const { manager, id } = await fixture(model);
    for (let index = 0; index < 9; index++) {
      const started = manager.start(id, `list ${index}`);
      const run = await finish(manager, started.runId);
      expect(run.result?.finishReason).toBe("completed");
      if (index === 8) expect(run.notice).toContain("裁剪");
    }
    const second = prompts[2];
    expect(second?.some((message) => message.role === "tool")).toBe(true);
    expect(second?.filter((message) => message.role === "user")).toHaveLength(2);
    expect(manager.snapshot().session?.messages).toHaveLength(16);
    const last = prompts.at(-1);
    expect(JSON.stringify(last)).not.toContain('"text":"list 0"');
    const calls =
      last
        ?.flatMap((message) => (message.role === "assistant" ? message.content : []))
        .filter((part) => typeof part !== "string" && part.type === "tool-call") ?? [];
    const results =
      last
        ?.flatMap((message) => (message.role === "tool" ? message.content : []))
        .filter((part) => part.type === "tool-result") ?? [];
    expect(calls).toHaveLength(results.length);
  });

  it("locks switching and parallel invokes until cancellation settles, then keeps a usable history", async () => {
    const model = createMockModel();
    const original = model.doStream;
    let signal: AbortSignal | undefined;
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let stall = true;
    model.doStream = async (call) => {
      if (stall) {
        signal = call.abortSignal;
        started();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
        });
      }
      return original(call);
    };
    const { manager, id } = await fixture(model);
    const run = manager.start(id, "wait");
    await ready;
    expect(() => manager.start(id, "parallel")).toThrow("请等待");
    expect(() => manager.reset()).toThrow("请等待");
    await expect(manager.select(async () => null)).rejects.toThrow("请等待");
    manager.cancel(run.runId);
    expect(signal?.aborted).toBe(true);
    expect((await finish(manager, run.runId)).result?.finishReason).toBe("ABORTED");
    stall = false;
    expect(
      (await finish(manager, manager.start(id, "text:continue").runId)).result?.output,
    ).toContain("continue");
    expect(manager.snapshot().session?.messages).toHaveLength(4);
  });

  it("keeps the current workspace if directory selection is cancelled", async () => {
    const { manager, id } = await fixture();
    expect(await manager.select(async () => null)).toEqual({ cancelled: true });
    expect(manager.snapshot().session?.id).toBe(id);
    await manager.close();
    expect(() => manager.start(id, "closed")).toThrow("正在停止");
  });
});
