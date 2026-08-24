#!/usr/bin/env node

"use strict";

const fs = require("node:fs/promises");

const MAX_TARGETS = 1_617;
const EMPTY_CONFIRMATION = "REPLACE_WITH_EMPTY";

function parseCsv(text) {
  const input = String(text).replace(/^\uFEFF/, "");
  const records = [];
  let record = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === ",") {
      record.push(cell);
      cell = "";
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (quoted) throw new Error("CSV has an unterminated quoted value.");
  if (cell.length > 0 || record.length > 0) {
    record.push(cell);
    records.push(record);
  }

  while (
    records.length > 0 &&
    records[records.length - 1].length === 1 &&
    records[records.length - 1][0] === ""
  ) {
    records.pop();
  }

  if (
    records.length === 0 ||
    records[0].length !== 2 ||
    records[0][0] !== "name" ||
    records[0][1] !== "endpoint"
  ) {
    throw new Error("CSV header must be exactly name,endpoint.");
  }

  const endpoints = new Set();
  const servers = records.slice(1).map((row, rowIndex) => {
    if (row.length !== 2) {
      throw new Error(`CSV row ${rowIndex + 2} must contain exactly two columns.`);
    }

    let [name, endpoint] = row;
    // The scanner adds this apostrophe only to prevent spreadsheet formulas.
    // Remove it before storing the original display name in D1.
    if (/^'[\s]*[=+\-@]/.test(name)) name = name.slice(1);
    name = name.trim();
    endpoint = endpoint.trim();

    if (!name || name.length > 240) {
      throw new Error(`CSV row ${rowIndex + 2} has an invalid name.`);
    }
    if (!endpoint || endpoint.length > 500 || /[\r\n\0]/.test(endpoint)) {
      throw new Error(`CSV row ${rowIndex + 2} has an invalid endpoint.`);
    }

    const endpointKey = endpoint.toLocaleLowerCase("en-US");
    if (endpoints.has(endpointKey)) {
      throw new Error(`CSV row ${rowIndex + 2} repeats endpoint ${endpoint}.`);
    }
    endpoints.add(endpointKey);
    return { name, endpoint };
  });

  if (servers.length > MAX_TARGETS) {
    throw new Error(`CSV contains more than ${MAX_TARGETS} targets.`);
  }
  return servers;
}

function targetsUrl(serviceUrl) {
  let parsed;
  try {
    parsed = new URL(serviceUrl);
  } catch {
    throw new Error("FIVEM_AUDITOR_SERVICE_URL is not a valid URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "FIVEM_AUDITOR_SERVICE_URL must be a clean HTTPS URL without credentials, query, or fragment.",
    );
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/api/v1/targets`;
  return parsed;
}

async function pushTargets({
  servers,
  serviceUrl,
  adminKey,
  allowEmpty = false,
  fetchImpl = fetch,
}) {
  if (!Array.isArray(servers)) throw new Error("servers must be an array.");
  if (!adminKey) throw new Error("FIVEM_AUDITOR_ADMIN_KEY is missing.");
  if (servers.length === 0 && !allowEmpty) {
    throw new Error(
      "The scan returned zero targets. Set ALLOW_EMPTY_TARGETS=true only when clearing stale inventory is intended.",
    );
  }

  const headers = {
    Authorization: `Bearer ${adminKey}`,
    "Content-Type": "application/json",
    "User-Agent": "fivem-flax-target-sync/1.0",
  };
  if (servers.length === 0) {
    headers["X-Confirm-Empty-Inventory"] = EMPTY_CONFIRMATION;
  }

  const response = await fetchImpl(targetsUrl(serviceUrl), {
    method: "PUT",
    headers,
    body: JSON.stringify({ servers }),
    signal: AbortSignal.timeout(30_000),
  });

  const responseText = await response.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(`Inventory service returned non-JSON HTTP ${response.status}.`);
  }

  if (!response.ok) {
    const reason = typeof result.error === "string" ? result.error : "request failed";
    throw new Error(`Inventory service returned HTTP ${response.status}: ${reason}`);
  }
  if (result.updated !== true || result.count !== servers.length) {
    throw new Error("Inventory service response did not confirm the expected replacement count.");
  }
  return result;
}

async function writeState(filePath, targetCount) {
  const state = {
    lastSuccessfulSync: new Date().toISOString(),
    resource: "flaxhosting_filer",
    targetCount,
  };
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    throw new Error("Usage: node push-targets.cjs <targets.csv>");
  }

  const servers = parseCsv(await fs.readFile(csvPath, "utf8"));
  const allowEmpty = process.env.ALLOW_EMPTY_TARGETS === "true";
  const result = await pushTargets({
    servers,
    serviceUrl: process.env.FIVEM_AUDITOR_SERVICE_URL || "",
    adminKey: process.env.FIVEM_AUDITOR_ADMIN_KEY || "",
    allowEmpty,
  });
  await writeState(".sync-state.json", result.count);
  process.stdout.write(
    `Cloudflare inventory replaced successfully with ${result.count} target(s).\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EMPTY_CONFIRMATION,
  parseCsv,
  pushTargets,
  targetsUrl,
};
