/**
 * HTML → PDF.
 *
 * No Linux PDF engine is installed on this machine, but this is WSL and Windows
 * Chrome is reachable through interop, so we drive it headless. Paths must be
 * translated with `wslpath -w`: the Windows binary cannot read `/home/...`.
 *
 * Verified working: Chrome headless produced a valid PDF 1.4 from a WSL path.
 *
 * Degrades honestly — if no engine is found this throws with the install
 * options rather than silently emitting an HTML file named `.pdf`.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PdfEngine {
  kind: "linux-chrome" | "windows-chrome";
  binary: string;
}

const LINUX_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
];

const WINDOWS_CANDIDATES = [
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
];

let cached: PdfEngine | null | undefined;

export async function detectPdfEngine(): Promise<PdfEngine | null> {
  if (cached !== undefined) return cached;

  for (const bin of LINUX_CANDIDATES) {
    const which = Bun.spawnSync(["sh", "-c", `command -v ${bin}`]);
    if (which.exitCode === 0) {
      cached = { kind: "linux-chrome", binary: bin };
      return cached;
    }
  }
  for (const path of WINDOWS_CANDIDATES) {
    if (existsSync(path)) {
      cached = { kind: "windows-chrome", binary: path };
      return cached;
    }
  }
  cached = null;
  return cached;
}

async function toWindowsPath(p: string): Promise<string> {
  const proc = Bun.spawn(["wslpath", "-w", p], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out) {
    throw new Error(`wslpath failed to translate ${p}`);
  }
  return out;
}

/**
 * Render an HTML string to a PDF at `outPath`. Returns the number of bytes
 * written. Throws with actionable text when no engine is available.
 */
export async function htmlToPdf(
  html: string,
  outPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<number> {
  const engine = await detectPdfEngine();
  if (!engine) {
    throw new Error(
      "no PDF engine found. Install one of: google-chrome / chromium on Linux, " +
        "or run under WSL with Windows Chrome installed. " +
        "(Checked PATH and standard Windows install locations.)",
    );
  }

  const dir = await mkdtemp(join(tmpdir(), "cv-pdf-"));
  const htmlPath = join(dir, "doc.html");
  await Bun.write(htmlPath, html);

  try {
    const [inArg, outArg] =
      engine.kind === "windows-chrome"
        ? [await toWindowsPath(htmlPath), await toWindowsPath(outPath)]
        : [htmlPath, outPath];

    const args = [
      engine.binary,
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--no-pdf-header-footer",
      "--print-to-pdf-no-header",
      `--print-to-pdf=${outArg}`,
      inArg,
    ];

    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => proc.kill(), opts.timeoutMs ?? 120_000);
    const code = await proc.exited;
    clearTimeout(timeout);

    const stderr = (await new Response(proc.stderr).text()).trim();

    const file = Bun.file(outPath);
    if (!(await file.exists())) {
      throw new Error(
        `PDF was not produced (exit ${code}). Engine: ${engine.binary}. ` +
          `stderr: ${stderr.slice(0, 400) || "(empty)"}`,
      );
    }
    const size = file.size;
    if (size < 1000) {
      throw new Error(`PDF at ${outPath} is implausibly small (${size} bytes)`);
    }

    // Confirm it is actually a PDF, not an error page written to disk.
    const head = await file.slice(0, 5).text();
    if (!head.startsWith("%PDF")) {
      throw new Error(`file at ${outPath} is not a PDF (magic bytes: ${JSON.stringify(head)})`);
    }

    return size;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
