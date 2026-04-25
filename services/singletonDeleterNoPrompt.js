#!/usr/bin/env node

import fs from "fs";
import path from "path";
import readline from "readline";

const SINGLETON_FILES = ["SingletonSocket", "SingletonLock", "SingletonCookie"];

const args = process.argv.slice(2);
const targetDir = args[0] || "./userData";

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// Look one level deep: userData/<profile-folder>/Singleton*
function findSingletonFiles(dir) {
  const found = []; // { profile, filePath, fileName }

  let profileDirs;
  try {
    profileDirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (err) {
    console.error(`${RED}Cannot read directory: ${dir}${RESET}`);
    process.exit(1);
  }

  for (const profileDir of profileDirs) {
    const profilePath = path.join(dir, profileDir.name);
    let entries;
    try {
      entries = fs.readdirSync(profilePath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if ((entry.isFile() || entry.isSymbolicLink()) && SINGLETON_FILES.includes(entry.name)) {
        found.push({
          profile: profileDir.name,
          filePath: path.join(profilePath, entry.name),
          fileName: entry.name,
        });
      }
    }
  }

  return found;
}

async function main() {
  const resolvedDir = path.resolve(targetDir);

  console.log(`\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${CYAN}  Chromium Singleton File Remover${RESET}`);
  console.log(`${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`  ${DIM}Target:${RESET}  ${resolvedDir}`);
  console.log(`${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n`);

  if (!fs.existsSync(resolvedDir)) {
    console.error(`${RED}Error: Directory not found: ${resolvedDir}${RESET}`);
    process.exit(1);
  }

  const singletons = findSingletonFiles(resolvedDir);

  if (singletons.length === 0) {
    console.log(`${GREEN}✓ No Chromium singleton files found. Nothing to remove.${RESET}\n`);
    return;
  }

  // Group by profile for display
  const byProfile = {};
  for (const s of singletons) {
    if (!byProfile[s.profile]) byProfile[s.profile] = [];
    byProfile[s.profile].push(s.fileName);
  }

  console.log(`${YELLOW}Found singleton files in ${Object.keys(byProfile).length} profile(s):${RESET}\n`);
  for (const [profile, files] of Object.entries(byProfile)) {
    console.log(`  ${DIM}📁 ${profile}/${RESET}`);
    for (const f of files) {
      console.log(`     ${RED}✗${RESET} ${f}`);
    }
  }

  console.log();
  const answer = await prompt(`${YELLOW}Delete these ${singletons.length} file(s)? [y/N]: ${RESET}`);

  if (answer !== "y" && answer !== "yes") {
    console.log(`\n${DIM}Aborted. No files were deleted.${RESET}\n`);
    return;
  }

  let removed = 0;
  let failed = 0;

  for (const { filePath, fileName, profile } of singletons) {
    try {
      fs.unlinkSync(filePath);
      console.log(`  ${GREEN}✓${RESET} ${DIM}${profile}/${RESET}${fileName}`);
      removed++;
    } catch (err) {
      console.log(`  ${RED}✗${RESET} ${DIM}${profile}/${RESET}${fileName} ${RED}(${err.message})${RESET}`);
      failed++;
    }
  }

  console.log(`\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`  ${GREEN}Done. ${removed} file(s) removed.${failed > 0 ? ` ${RED}${failed} failed.` : ""}${RESET}`);
  console.log(`${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n`);
}

main();