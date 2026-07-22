/**
 * File uploads → session context.
 *
 * The frontend paperclip lets a user attach files to a turn. But a session's
 * writable workspace (where the Claude child can Read files) only exists once the
 * session starts — and a session starts *with* the first prompt. So uploads are a
 * separate step, decoupled from the turn:
 *
 *   1. POST /uploads stages the bytes in a temp dir and returns an `uploadId`.
 *   2. The turn request (/sessions or /sessions/:id/messages) carries that id.
 *   3. When the turn runs, attachUploads() moves the staged files into the
 *      session workspace under `uploads/`, and the prompt is augmented to tell the
 *      agent they're there — so its Read/Grep tools pull them into context.
 *
 * Staging lives under WORKSPACE_ROOT alongside session workspaces (same disk,
 * same "no GC yet" posture — an unclaimed upload leaks until reboot; a claimed
 * one is moved out and its staging dir removed). Base64/JSON transport avoids a
 * multipart parser (this repo carries almost no deps); a total-size cap bounds
 * the in-memory decode.
 */

import { mkdtempSync, mkdirSync, writeFileSync, renameSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = process.env.WORKSPACE_ROOT || tmpdir();

/** Cap the total decoded size of one /uploads request (bytes). Overridable. */
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024);
/** Cap the number of files in one request. */
export const MAX_UPLOAD_FILES = Number(process.env.MAX_UPLOAD_FILES ?? 20);

/** Subdirectory (relative to the session cwd) uploaded files land in. */
export const UPLOAD_SUBDIR = "uploads";

export interface UploadInput {
  name: string;
  /** base64-encoded file bytes. */
  dataBase64: string;
}

export interface StagedFile {
  name: string; // sanitized, workspace-relative basename
  size: number; // bytes
}

/** uploadId -> staging dir on disk. Claimed (moved out) or dropped on attach. */
const staged = new Map<string, { dir: string; files: StagedFile[] }>();

/**
 * Reduce an arbitrary client-supplied filename to a safe basename: strip any
 * path components (defeats `../` traversal and absolute paths) and control
 * characters, and fall back to a generic name if nothing usable remains.
 */
function safeName(raw: string): string {
  // Normalize backslashes to slashes so basename() strips Windows-style paths
  // too, then drop control characters that could confuse the shell/logs.
  const cleaned = String(raw ?? "")
    .replace(/\\/g, "/")
    .split("")
    .filter((c) => c.charCodeAt(0) >= 0x20)
    .join("");
  const base = basename(cleaned).trim();
  // Reject names that resolve to a directory ref or are empty after cleaning.
  if (!base || base === "." || base === "..") return "file";
  return base.slice(0, 200);
}

/** Make `name` unique within `used`, suffixing "-1", "-2", … before any ext. */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Stage a batch of uploaded files to a temp dir and return an id to claim them
 * with. Validates count and total size; throws on violation (the caller maps it
 * to a 4xx). Filenames are sanitized and de-duplicated.
 */
export function stageUploads(inputs: UploadInput[]): { uploadId: string; files: StagedFile[] } {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("no files");
  if (inputs.length > MAX_UPLOAD_FILES) throw new Error(`too many files (max ${MAX_UPLOAD_FILES})`);

  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, "ada-upload-"));
  const files: StagedFile[] = [];
  const used = new Set<string>();
  let total = 0;
  try {
    for (const input of inputs) {
      const bytes = Buffer.from(String(input?.dataBase64 ?? ""), "base64");
      total += bytes.length;
      if (total > MAX_UPLOAD_BYTES) throw new Error(`upload too large (max ${MAX_UPLOAD_BYTES} bytes)`);
      const name = uniqueName(safeName(input?.name), used);
      used.add(name);
      writeFileSync(join(dir, name), bytes);
      files.push({ name, size: bytes.length });
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const uploadId = `upl_${randomUUID()}`;
  staged.set(uploadId, { dir, files });
  return { uploadId, files };
}

/**
 * Claim one or more staged uploads into a session workspace: move each file into
 * `${cwd}/uploads/`, then discard the staging dirs. Unknown ids are skipped.
 * Returns the workspace-relative files that landed, for prompt augmentation.
 *
 * A cross-device rename (staging and workspace on different mounts) falls back to
 * copy+unlink so the move still succeeds.
 */
export function attachUploads(cwd: string, uploadIds: string[]): StagedFile[] {
  const dest = join(cwd, UPLOAD_SUBDIR);
  const claimed: StagedFile[] = [];
  const used = new Set<string>();
  for (const id of uploadIds) {
    const entry = staged.get(id);
    if (!entry) continue;
    mkdirSync(dest, { recursive: true });
    for (const f of entry.files) {
      // Re-uniquify against files already attached this turn (two uploads could
      // each carry a "notes.txt").
      const name = uniqueName(f.name, used);
      used.add(name);
      const from = join(entry.dir, f.name);
      const to = join(dest, name);
      try {
        renameSync(from, to);
      } catch {
        copyFileSync(from, to);
        rmSync(from, { force: true });
      }
      claimed.push({ name, size: f.size });
    }
    rmSync(entry.dir, { recursive: true, force: true });
    staged.delete(id);
  }
  return claimed;
}

/**
 * Build the server-side prompt sent to Claude when a turn has attachments: the
 * user's text plus a note pointing at the saved files. Kept out of the UI's user
 * bubble (which shows the raw prompt); this is only what the agent sees.
 */
export function augmentPrompt(prompt: string, files: StagedFile[]): string {
  if (files.length === 0) return prompt;
  const list = files.map((f) => `- ${UPLOAD_SUBDIR}/${f.name} (${f.size} bytes)`).join("\n");
  const note =
    `The user attached ${files.length} file${files.length === 1 ? "" : "s"}, saved in your ` +
    `working directory. Read them as needed to answer:\n${list}`;
  return prompt ? `${prompt}\n\n${note}` : note;
}
