#!/usr/bin/env bun
/**
 * Copy the canonical skill (skills/curriculum/) to where agents look for it:
 *   .claude/skills/curriculum/   Claude Code, when the repository is opened
 *   .agents/skills/curriculum/   OpenAI Codex (and other Agent Skills readers)
 * The Claude Code plugin reads skills/ directly. Copies, not symlinks: symlinks
 * do not survive every checkout (Windows) or every skill loader.
 *
 *   bun run scripts/sync-skill.ts
 */

import { cpSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../src/corpus/load.ts";

const source = join(PROJECT_ROOT, "skills", "curriculum");
for (const target of [join(PROJECT_ROOT, ".claude", "skills", "curriculum"), join(PROJECT_ROOT, ".agents", "skills", "curriculum")]) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, ".."), { recursive: true });
  cpSync(source, target, { recursive: true });
  console.log(`synced ${target.replace(PROJECT_ROOT + "/", "")}`);
}
