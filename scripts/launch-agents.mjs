#!/usr/bin/env node
// Usage: node launch-agents.mjs <service-url> <agent-id> [prompt] [--no-continue]
// Fetches connected agents and launches each in a new terminal with title.

import { execSync } from "node:child_process";
import os from "node:os";

const SERVICE_URL = process.argv[2];
const AGENT_ID = process.argv[3];
const PROMPT = process.argv[4] || "";
const NO_CONTINUE = process.argv.includes("--no-continue");

if (!SERVICE_URL || !AGENT_ID) {
  console.error("Usage: node launch-agents.mjs <service-url> <agent-id> [prompt] [--no-continue]");
  process.exit(1);
}

const res = await fetch(`${SERVICE_URL}/agents/${AGENT_ID}/connections`);
const connections = await res.json();

if (!connections.length) {
  console.log("No connected agents found.");
  process.exit(0);
}

for (const conn of connections) {
  try {
    const r = await fetch(`${SERVICE_URL}/agents/${conn.id}`);
    const agent = await r.json();

    if (!agent.cwd) {
      console.log(`  SKIP ${conn.id} (no cwd)`);
      continue;
    }

    let cmd = agent.launchCommand || "claude --dangerously-load-development-channels server:swarm-plugin --dangerously-skip-permissions";

    // Add --continue for restart (session exists)
    if (!NO_CONTINUE && !cmd.includes("--continue")) {
      cmd = cmd.replace("claude ", "claude --continue ");
    }

    if (PROMPT) {
      cmd += ` "${PROMPT}"`;
    }

    const title = `Swarm: ${agent.name || conn.id} (${conn.id})`;
    const platform = os.platform();

    console.log(`  Launching ${conn.id} in ${agent.cwd} [${title}]`);

    if (platform === "win32") {
      execSync(`start "${title}" cmd /k "cd /d "${agent.cwd}" && ${cmd}"`, { stdio: "ignore", shell: true });
    } else if (platform === "darwin") {
      const escaped = cmd.replace(/'/g, "\\'");
      execSync(`osascript -e 'tell application "Terminal" to do script "printf \\'\\\\e]0;${title}\\\\a\\' && cd \\'${agent.cwd}\\' && ${escaped}"'`, { stdio: "ignore" });
    } else {
      execSync(`x-terminal-emulator -T "${title}" -e bash -c "cd '${agent.cwd}' && ${cmd}; exec bash" 2>/dev/null || gnome-terminal --title="${title}" -- bash -c "cd '${agent.cwd}' && ${cmd}; exec bash"`, { stdio: "ignore" });
    }
  } catch (e) {
    console.log(`  FAILED ${conn.id}: ${e.message}`);
  }
}
