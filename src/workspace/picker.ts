import { spawn } from "node:child_process";

export type DirectoryPickerErrorCode =
  | "PICKER_BUSY"
  | "PICKER_UNAVAILABLE"
  | "PICKER_FAILED"
  | "PICKER_TIMEOUT"
  | "PICKER_ABORTED";

const messages: Record<DirectoryPickerErrorCode, string> = {
  PICKER_BUSY: "目录选择窗口已打开，请先完成或取消选择。",
  PICKER_UNAVAILABLE: "目录选择器需要可交互的 Windows 桌面。",
  PICKER_FAILED: "目录选择失败，请重试。",
  PICKER_TIMEOUT: "目录选择超时，请重新打开选择窗口。",
  PICKER_ABORTED: "目录选择已取消。",
};

export class DirectoryPickerError extends Error {
  constructor(readonly code: DirectoryPickerErrorCode) {
    super(messages[code]);
    this.name = "DirectoryPickerError";
  }
}

// This script is constant: no request data, paths or commands are interpolated.
// EncodedCommand is UTF-16LE; the selected path is returned as UTF-8 base64.
const pickerScript = `
$ErrorActionPreference = 'Stop'
$dialog = $null
try {
  if (-not [Environment]::UserInteractive) {
    [Console]::Out.WriteLine('UNAVAILABLE')
    exit 0
  }
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = '选择 Lore 工作区目录'
  $dialog.ShowNewFolderButton = $false
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)
    [Console]::Out.WriteLine('OK:' + [Convert]::ToBase64String($bytes))
  } else {
    [Console]::Out.WriteLine('CANCEL')
  }
} catch {
  exit 1
} finally {
  if ($null -ne $dialog) { $dialog.Dispose() }
}
`;
const encodedCommand = Buffer.from(pickerScript, "utf16le").toString("base64");
const timeoutMs = 120_000;
const maxOutputBytes = 64 * 1024;
let dialogOpen = false;

export async function pickDirectory(signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) throw new DirectoryPickerError("PICKER_ABORTED");
  if (process.platform !== "win32" || process.env.SESSIONNAME?.toLowerCase() === "services") {
    throw new DirectoryPickerError("PICKER_UNAVAILABLE");
  }
  if (dialogOpen) throw new DirectoryPickerError("PICKER_BUSY");
  dialogOpen = true;

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "powershell.exe",
        ["-STA", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
        { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      dialogOpen = false;
      reject(new DirectoryPickerError("PICKER_UNAVAILABLE"));
      return;
    }

    let settled = false;
    let output = "";
    let outputBytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const fail = (code: DirectoryPickerErrorCode, kill = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (kill) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Retain the busy guard until close, even if termination failed.
        }
      }
      reject(new DirectoryPickerError(code));
    };
    const abort = () => fail("PICKER_ABORTED", true);
    const timer = setTimeout(() => fail("PICKER_TIMEOUT", true), timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        fail("PICKER_FAILED", true);
        return;
      }
      output += chunk.toString("ascii");
    });
    // Do not expose PowerShell diagnostics or local environment details.
    child.stderr?.resume();
    child.once("error", () => fail("PICKER_UNAVAILABLE", true));
    child.once("close", (code) => {
      dialogOpen = false;
      if (settled) return;
      if (code !== 0) {
        fail("PICKER_FAILED");
        return;
      }
      const response = output.trim();
      if (response === "UNAVAILABLE") {
        fail("PICKER_UNAVAILABLE");
        return;
      }
      let directory: string | null = null;
      if (response !== "CANCEL") {
        const match = /^OK:([A-Za-z0-9+/]+={0,2})$/.exec(response);
        const encoded = match?.[1];
        if (!encoded) {
          fail("PICKER_FAILED");
          return;
        }
        const bytes = Buffer.from(encoded, "base64");
        directory = bytes.toString("utf8");
        if (
          bytes.toString("base64") !== encoded ||
          !Buffer.from(directory, "utf8").equals(bytes) ||
          !directory ||
          directory.includes("\0")
        ) {
          fail("PICKER_FAILED");
          return;
        }
      }
      settled = true;
      cleanup();
      resolve(directory);
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
