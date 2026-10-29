import { createContext, Script } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { workspacePage } from "./page.js";

class Element {
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  className = "";
  scrollTop = 0;
  scrollHeight = 0;
  children: Element[] = [];
  listeners = new Map<string, (event: { preventDefault(): void }) => unknown>();
  get childElementCount() {
    return this.children.length;
  }
  append(...elements: Element[]) {
    this.children.push(...elements);
  }
  replaceChildren() {
    this.children = [];
  }
  addEventListener(name: string, handler: (event: { preventDefault(): void }) => unknown) {
    this.listeners.set(name, handler);
  }
  async trigger(name: string) {
    await this.listeners.get(name)?.({ preventDefault() {} });
  }
}

const emptySession = {
  id: "session-1",
  root: "D:\\工作区",
  messages: [],
  running: false,
  runId: null,
};
function response(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}
async function flush() {
  for (let count = 0; count < 30; count++) await Promise.resolve();
}
async function boot(fetch: ReturnType<typeof vi.fn>) {
  const elements = new Map<string, Element>();
  const document = {
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement() {
      return new Element();
    },
  };
  const script = /<script nonce="__LORE_NONCE__">([\s\S]*?)<\/script>/.exec(workspacePage)?.[1];
  if (!script) throw new Error("Missing inline script");
  new Script(script).runInContext(createContext({ document, fetch, setTimeout, clearTimeout }));
  await flush();
  const ui = (id: string) => {
    const element = elements.get(id);
    if (!element) throw new Error(`Unknown element ${id}`);
    return element;
  };
  return ui;
}

afterEach(() => vi.useRealTimers());

it("opens the native picker, preserves cancelled selections, and resets for a new session", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response({ session: null }))
    .mockResolvedValueOnce(response({ session: emptySession }))
    .mockResolvedValueOnce(response({ cancelled: true }))
    .mockResolvedValueOnce(response({ session: null }))
    .mockResolvedValueOnce(response({ session: { ...emptySession, id: "session-2" } }));
  const ui = await boot(fetch);
  expect(ui("send").disabled).toBe(true);
  await ui("select").trigger("click");
  expect(ui("directory").textContent).toBe(emptySession.root);
  expect(fetch.mock.calls[1]?.[0]).toBe("/workspace/select");
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({
    method: "POST",
    body: "{}",
    mode: "same-origin",
  });
  await ui("select").trigger("click");
  expect(ui("directory").textContent).toBe(emptySession.root);
  expect(ui("status").textContent).toContain("已取消");
  await ui("reset").trigger("click");
  expect(fetch.mock.calls[3]?.[0]).toBe("/workspace/reset");
  expect(fetch.mock.calls[4]?.[0]).toBe("/workspace/select");
  expect(ui("directory").textContent).toBe(emptySession.root);
});

it("ignores a late cancel response after polling confirms completion", async () => {
  vi.useFakeTimers();
  let resolveCancel: (value: unknown) => void = () => {};
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      response({ session: { ...emptySession, running: true, runId: "run-1" } }),
    )
    .mockResolvedValueOnce(response({ id: "run-1", status: "running", events: [], changes: [] }))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCancel = resolve;
        }),
    )
    .mockResolvedValueOnce(
      response({
        id: "run-1",
        status: "finished",
        events: [],
        changes: [],
        result: { finishReason: "completed" },
      }),
    )
    .mockResolvedValueOnce(response({ session: emptySession }));
  const ui = await boot(fetch);
  const cancelling = ui("cancel").trigger("click");
  await vi.advanceTimersByTimeAsync(1200);
  await flush();
  expect(ui("status").textContent).toBe("执行完成");
  resolveCancel(response({ cancelled: true }));
  await cancelling;
  expect(ui("status").textContent).toBe("执行完成");
});

it("contains only local inline assets with CSP nonce placeholders", () => {
  expect(workspacePage).toContain('<style nonce="__LORE_NONCE__">');
  expect(workspacePage).toContain('<script nonce="__LORE_NONCE__">');
  expect(workspacePage).not.toMatch(/innerHTML|https?:\/\//);
});

it("recovers a server run and keeps sends locked during poll failures", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      response({ session: { ...emptySession, running: true, runId: "run-1" } }),
    )
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(
      response({
        id: "run-1",
        status: "finished",
        events: [],
        changes: [
          {
            path: "<img onerror=alert(1)>",
            kind: "created",
            before: null,
            after: "<script>unsafe</script>",
          },
        ],
        result: { finishReason: "completed" },
      }),
    )
    .mockResolvedValueOnce(response({ session: emptySession, notice: "旧的上下文已裁剪" }));
  const ui = await boot(fetch);
  expect(ui("send").disabled).toBe(true);
  expect(ui("select").disabled).toBe(true);
  expect(ui("status").textContent).toContain("尚未确认");
  expect(ui("cancel").disabled).toBe(false);
  await vi.advanceTimersByTimeAsync(1200);
  await flush();
  expect(ui("message").disabled).toBe(false);
  expect(ui("select").disabled).toBe(false);
  expect(ui("notice").textContent).toBe("旧的上下文已裁剪");
  const details = ui("changes").children[0];
  expect(details?.children[0]?.textContent).toContain("<img onerror=alert(1)>");
  expect(details?.children[4]?.textContent).toBe("+ <script>unsafe</script>");
  const requests = fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetch).toHaveBeenCalledTimes(requests);
});

it("loads the latest finished run after a page reload without continued polling", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response({ session: { ...emptySession, runId: "finished-run" } }))
    .mockResolvedValueOnce(
      response({
        id: "finished-run",
        status: "finished",
        events: [],
        changes: [],
        result: { finishReason: "completed" },
      }),
    )
    .mockResolvedValueOnce(response({ session: emptySession }));
  const ui = await boot(fetch);
  expect(fetch.mock.calls[1]?.[0]).toBe("/workspace/run/finished-run");
  expect(ui("status").textContent).toBe("执行完成");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("keeps uncertain submission locked until a canonical refresh confirms idle", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response({ session: emptySession }))
    .mockRejectedValueOnce(new Error("response lost"))
    .mockResolvedValueOnce(response({ session: emptySession }));
  const ui = await boot(fetch);
  ui("message").value = "读取说明";
  await ui("message").trigger("input");
  await ui("composer").trigger("submit");
  expect(ui("send").disabled).toBe(true);
  expect(ui("select").disabled).toBe(true);
  expect(ui("status").textContent).toContain("是否已提交尚未确认");
  await ui("refresh").trigger("click");
  expect(ui("send").disabled).toBe(false);
  expect(ui("message").value).toBe("读取说明");
});

it("waits for finished after cancellation and shows live events using text", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      response({ session: { ...emptySession, running: true, runId: "run-1" } }),
    )
    .mockResolvedValueOnce(
      response({
        id: "run-1",
        status: "running",
        events: [
          {
            event: "tool_requested",
            tool: "read_file",
            path: "notes.txt",
            status: "requested",
            durationMs: 10,
          },
        ],
        changes: [],
      }),
    )
    .mockResolvedValueOnce(response({ cancelled: true }))
    .mockResolvedValueOnce(
      response({
        id: "run-1",
        status: "finished",
        events: [],
        changes: [],
        result: { finishReason: "ABORTED" },
      }),
    )
    .mockResolvedValueOnce(response({ session: emptySession }));
  const ui = await boot(fetch);
  expect(ui("events").children[0]?.textContent).toContain("read_file · notes.txt");
  await ui("cancel").trigger("click");
  expect(ui("send").disabled).toBe(true);
  expect(ui("select").disabled).toBe(true);
  expect(ui("cancel").disabled).toBe(true);
  expect(fetch.mock.calls[2]?.[0]).toBe("/workspace/run/run-1/cancel");
  await vi.advanceTimersByTimeAsync(1200);
  await flush();
  expect(ui("select").disabled).toBe(false);
  expect(ui("error").textContent).toContain("已完成的文件写入仍然保留");
});
