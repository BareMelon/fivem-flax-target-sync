#!/usr/bin/env node

"use strict";

const fs = require("node:fs");

const THREE_DAYS_MS = 72 * 60 * 60 * 1_000;

function shouldRun({ state, now = Date.now(), manual = false }) {
  if (manual || !state || typeof state.lastSuccessfulSync !== "string") return true;
  const lastRun = Date.parse(state.lastSuccessfulSync);
  return !Number.isFinite(lastRun) || now - lastRun >= THREE_DAYS_MS;
}

function main() {
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(".sync-state.json", "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      process.stderr.write("Existing sync state is invalid; running safely now.\n");
    }
  }

  const due = shouldRun({
    state,
    manual: process.env.GITHUB_EVENT_NAME === "workflow_dispatch",
  });
  const output = process.env.GITHUB_OUTPUT;
  if (output) fs.appendFileSync(output, `due=${due}\n`, "utf8");
  process.stdout.write(due ? "The three-day sync is due.\n" : "Not due yet; no scan needed.\n");
}

if (require.main === module) main();

module.exports = { shouldRun, THREE_DAYS_MS };
