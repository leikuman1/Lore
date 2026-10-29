import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

let child: EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("process", { platform: "win32", env: {} });
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  spawn.mockReset().mockReturnValue(child);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function picker() {
  return (await import("./picker.js")).pickDirectory;
}

function close(output: string, code = 0) {
  child.stdout.write(output);
  child.emit("close", code);
}

describe("native directory picker without opening a dialog", () => {
  it("uses a fixed STA command and decodes Unicode paths", async () => {
    const pickDirectory = await picker();
    const pending = pickDirectory();
    const path = "D:\\工作资料\\emoji-📁";
    close(`OK:${Buffer.from(path, "utf8").toString("base64")}\r\n`);
    await expect(pending).resolves.toBe(path);
    const [executable, args, options] = spawn.mock.calls[0] ?? [];
    expect(executable).toBe("powershell.exe");
    expect(args.slice(0, 4)).toEqual(["-STA", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(Buffer.from(args[4], "base64").toString("utf16le")).toContain(
      "System.Windows.Forms.FolderBrowserDialog",
    );
    expect(options).toMatchObject({ shell: false, windowsHide: true });
  });

  it("returns null on user cancellation and releases the dialog guard", async () => {
    const pickDirectory = await picker();
    const first = pickDirectory();
    close("CANCEL");
    await expect(first).resolves.toBeNull();
    const second = pickDirectory();
    close("CANCEL");
    await expect(second).resolves.toBeNull();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("blocks concurrent dialogs until an aborted child actually closes", async () => {
    const pickDirectory = await picker();
    const controller = new AbortController();
    const pending = pickDirectory(controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "PICKER_ABORTED" });
    controller.abort();
    await rejected;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(pickDirectory()).rejects.toMatchObject({ code: "PICKER_BUSY" });
    close("CANCEL");
    const next = pickDirectory();
    close("CANCEL");
    await expect(next).resolves.toBeNull();
  });

  it("kills timed out dialogs without exposing process diagnostics", async () => {
    const pickDirectory = await picker();
    const pending = pickDirectory();
    const rejected = expect(pending).rejects.toMatchObject({ code: "PICKER_TIMEOUT" });
    vi.advanceTimersByTime(120_000);
    await rejected;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    close("", 1);
  });

  it.each(["OK:%%%", "OK:/w==", "arbitrary output", "OK:"])(
    "rejects malformed protocol output: %s",
    async (output) => {
      const pending = (await picker())();
      close(output);
      await expect(pending).rejects.toMatchObject({ code: "PICKER_FAILED" });
    },
  );

  it("rejects excess output and kills the child", async () => {
    const pending = (await picker())();
    const rejected = expect(pending).rejects.toMatchObject({ code: "PICKER_FAILED" });
    child.stdout.write("A".repeat(64 * 1024 + 1));
    await rejected;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    close("");
  });

  it("maps spawn errors to a stable unavailable error", async () => {
    const pending = (await picker())();
    child.emit("error", new Error("private process diagnostic"));
    await expect(pending).rejects.toMatchObject({ code: "PICKER_UNAVAILABLE" });
    close("", 1);
  });

  it.each(["linux", "darwin"])("rejects unsupported platform %s", async (platform) => {
    vi.stubGlobal("process", { platform, env: {} });
    await expect((await picker())()).rejects.toMatchObject({ code: "PICKER_UNAVAILABLE" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a Windows service desktop without spawning", async () => {
    vi.stubGlobal("process", { platform: "win32", env: { SESSIONNAME: "Services" } });
    await expect((await picker())()).rejects.toMatchObject({ code: "PICKER_UNAVAILABLE" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not spawn for an already aborted request", async () => {
    await expect((await picker())(AbortSignal.abort())).rejects.toMatchObject({
      code: "PICKER_ABORTED",
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
