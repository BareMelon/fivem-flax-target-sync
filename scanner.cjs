#!/usr/bin/env node

"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const protobuf = require("protobufjs/light");

const DIRECTORY_URL =
  "https://frontend.cfx-services.net/api/servers/streamRedir/";
const SERVER_DETAILS_URL =
  "https://frontend.cfx-services.net/api/servers/single/";

const MASTER_SCHEMA = {
  nested: {
    master: {
      nested: {
        ServerData: {
          fields: {
            hostname: { type: "string", id: 4 },
            resources: { rule: "repeated", type: "string", id: 8 },
            vars: { keyType: "string", type: "string", id: 12 },
            connectEndPoints: {
              rule: "repeated",
              type: "string",
              id: 18,
            },
          },
        },
        Server: {
          fields: {
            EndPoint: { type: "string", id: 1 },
            Data: { type: "ServerData", id: 2 },
          },
        },
      },
    },
  },
};

const HELP = `Danish FiveM server scanner

Usage:
  node scanner.cjs [options]

Options:
  -o, --output <file>       CSV destination (default: danish_fivem_servers.csv)
  --endpoint <mode>         auto, direct, or join (default: auto)
  --resource <name>         Keep only servers using this exact resource name
  --strict-locale           Only accept the self-reported da/da-DK locale
  -h, --help                Show this help

Endpoint modes:
  auto    Prefer a public direct endpoint; otherwise use the Cfx.re join URL
  direct  Same as auto, but makes the preference explicit
  join    Always write https://cfx.re/join/<server-id>
`;

function parseArgs(argv) {
  const options = {
    output: "danish_fivem_servers.csv",
    endpoint: "auto",
    resource: null,
    strictLocale: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--strict-locale") {
      options.strictLocale = true;
    } else if (arg === "-o" || arg === "--output") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a file path`);
      }
      options.output = value;
      i += 1;
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else if (arg === "--endpoint") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--endpoint requires auto, direct, or join");
      }
      options.endpoint = value.toLowerCase();
      i += 1;
    } else if (arg.startsWith("--endpoint=")) {
      options.endpoint = arg.slice("--endpoint=".length).toLowerCase();
    } else if (arg === "--resource") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--resource requires a resource name");
      }
      options.resource = value.trim();
      i += 1;
    } else if (arg.startsWith("--resource=")) {
      options.resource = arg.slice("--resource=".length).trim();
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!new Set(["auto", "direct", "join"]).has(options.endpoint)) {
    throw new Error("--endpoint must be auto, direct, or join");
  }

  if (options.resource === "") {
    throw new Error("--resource requires a non-empty resource name");
  }

  return options;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function downloadDirectory() {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(DIRECTORY_URL, {
        redirect: "follow",
        headers: {
          Accept: "application/octet-stream,application/json;q=0.9,*/*;q=0.8",
          "User-Agent": "fivem-danish-server-scanner/1.0",
        },
        signal: AbortSignal.timeout(90_000),
      });

      if (!response.ok) {
        throw new Error(`directory returned HTTP ${response.status}`);
      }

      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await wait(500 * attempt);
      }
    }
  }

  throw new Error(`Could not download the Cfx.re directory: ${lastError.message}`);
}

async function downloadServerDetails(id) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(
        `${SERVER_DETAILS_URL}${encodeURIComponent(id)}`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "fivem-danish-server-scanner/1.0",
          },
          signal: AbortSignal.timeout(20_000),
        },
      );

      if (!response.ok) {
        const error = new Error(
          `server ${id} returned HTTP ${response.status}`,
        );
        error.status = response.status;
        throw error;
      }

      const server = await response.json();
      if (!server || !server.EndPoint || !server.Data) {
        throw new Error(`server ${id} returned an invalid record`);
      }

      return server;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        // Uncached individual records can briefly return 429. Serial checks
        // plus a progressive wait avoid dropping valid servers from the CSV.
        const delay = error.status === 429
          ? 1_250 * attempt
          : 400 * attempt;
        await wait(delay);
      }
    }
  }

  throw lastError;
}

async function downloadDirectServerInfo(server) {
  const direct = (server.Data.connectEndPoints || []).find(
    isUsableDirectEndpoint,
  );
  if (!direct) {
    throw new Error(`server ${server.EndPoint} has no public direct endpoint`);
  }

  const baseUrl = normalizeDirectEndpoint(direct);
  const infoUrl = new URL(
    "info.json",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(infoUrl, {
        headers: {
          Accept: "application/json",
          "User-Agent": "fivem-danish-server-scanner/1.0",
        },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        throw new Error(
          `direct info for ${server.EndPoint} returned HTTP ${response.status}`,
        );
      }
      const info = await response.json();
      if (!Array.isArray(info.resources)) {
        throw new Error(
          `direct info for ${server.EndPoint} omitted the resource list`,
        );
      }
      return info;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(500);
    }
  }

  throw lastError;
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.min(concurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

async function requireResource(candidates, resourceName) {
  const target = resourceName.toLocaleLowerCase("en-US");

  async function checkCandidate(candidate) {
    try {
      let detailedServer = candidate.server;
      let resources;

      try {
        detailedServer = await downloadServerDetails(
          candidate.server.EndPoint,
        );
        resources = detailedServer.Data.resources || [];
      } catch (detailsError) {
        try {
          const directInfo = await downloadDirectServerInfo(candidate.server);
          resources = directInfo.resources;
        } catch (directError) {
          // The directory is a point-in-time snapshot. If the individual Cfx
          // record returns 404 throughout its retry window and the old direct
          // endpoint is also unavailable, the listing disappeared during the
          // scan. It is safely absent from the replacement inventory rather
          // than an unverifiable live server.
          if (detailsError.status === 404) {
            await wait(100);
            return { candidate, match: null, failure: null };
          }
          throw new Error(
            `${detailsError.message}; fallback failed: ${directError.message}`,
          );
        }
      }

      const usesResource = resources.some(
        (resource) => String(resource).toLocaleLowerCase("en-US") === target,
      );

      await wait(100);
      return {
        candidate,
        match: usesResource
          ? { ...candidate, server: detailedServer }
          : null,
        failure: null,
      };
    } catch (error) {
      await wait(100);
      return {
        candidate,
        match: null,
        failure: {
          id: candidate.server.EndPoint,
          message: error.message,
        },
      };
    }
  }

  const firstPass = await mapConcurrent(candidates, 1, checkCandidate);
  const verifiedMatches = firstPass
    .filter((result) => !result.failure && result.match)
    .map((result) => result.match);
  const firstPassFailures = firstPass.filter((result) => result.failure);

  // A record that exhausts its first retry window is often available moments
  // later. Retry only those IDs once more instead of rescanning every server.
  let finalFailures = firstPassFailures;
  if (firstPassFailures.length > 0) {
    await wait(2_500);
    const secondPass = await mapConcurrent(
      firstPassFailures.map((result) => result.candidate),
      1,
      checkCandidate,
    );
    verifiedMatches.push(
      ...secondPass
        .filter((result) => !result.failure && result.match)
        .map((result) => result.match),
    );
    finalFailures = secondPass.filter((result) => result.failure);
  }

  return {
    candidates: verifiedMatches,
    failedChecks: finalFailures.length,
    failureDetails: finalFailures.map((result) => result.failure),
  };
}

function decodeDirectory(buffer) {
  const root = protobuf.Root.fromJSON(MASTER_SCHEMA);
  const serverType = root.lookupType("master.Server");
  const servers = [];
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    offset += 4;

    if (length === 0 || offset + length > buffer.length) {
      break;
    }

    const message = serverType.decode(buffer.subarray(offset, offset + length));
    offset += length;

    const server = serverType.toObject(message, {
      arrays: true,
      objects: true,
    });

    if (server.EndPoint && server.Data) {
      servers.push(server);
    }
  }

  return servers;
}

function splitTags(value) {
  return String(value || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function danishEvidence(server, strictLocale) {
  const vars = server.Data.vars || {};
  const locale = String(vars.locale || "").trim();
  const localeMatch = /^da(?:[-_]|$)/i.test(locale);

  if (strictLocale || localeMatch) {
    return localeMatch ? ["locale"] : [];
  }

  const tags = splitTags(vars.tags);
  const searchable = [
    server.Data.hostname,
    vars.sv_projectName,
    vars.sv_projectDesc,
    ...tags,
  ]
    .filter(Boolean)
    .join(" ");

  const identityWord =
    /(^|[^a-zæøå])(dansk(?:e|er)?|danmark|danish|denmark|rollespil)(?=$|[^a-zæøå])/iu;
  // Uppercase, standalone DK is a common country marker. Keeping this
  // case-sensitive and alphanumeric-bounded avoids matching text such as a
  // Discord invite ending in "Dk6..." or an unrelated tag like "187dk".
  const countryMarker =
    /(^|[^A-Za-z0-9])DK(?:['´’]s)?(?=$|[^A-Za-z0-9])/;
  const countryDomain = /\.dk(?=$|[^a-z0-9])/i;
  const countryTag = tags.some((tag) => /^(?:dk|da)$/i.test(tag));
  const distinctiveDanish =
    /(^|[^a-zæøå])(åbent\s*hus|åbenhus|udvikling|søger|fællesskab|nytænkende)(?=$|[^a-zæøå])/iu;

  const evidence = [];
  if (identityWord.test(searchable)) evidence.push("Danish identity text");
  if (
    countryMarker.test(searchable) ||
    countryDomain.test(searchable) ||
    countryTag
  ) {
    evidence.push("DK marker");
  }
  if (distinctiveDanish.test(searchable)) evidence.push("Danish-language text");
  return evidence;
}

function cleanName(server) {
  const vars = server.Data.vars || {};
  const raw = server.Data.hostname || vars.sv_projectName || server.EndPoint;

  return String(raw)
    .replace(/\^(?:[0-9]|#[0-9a-f]{6})/gi, "")
    .replace(/~[a-z]~/gi, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsableDirectEndpoint(value) {
  if (!value) return false;
  const endpoint = String(value).trim();
  return (
    endpoint.length > 0 &&
    !/private-placeholder\.cfx\.re/i.test(endpoint)
  );
}

function normalizeDirectEndpoint(value) {
  const endpoint = String(value).trim();
  if (/^https?:\/\//i.test(endpoint)) return endpoint;

  // Turn an unbracketed IPv6 host plus port into a valid HTTP URL.
  const lastColon = endpoint.lastIndexOf(":");
  if (
    !endpoint.startsWith("[") &&
    lastColon > 0 &&
    endpoint.slice(0, lastColon).includes(":") &&
    /^\d+$/.test(endpoint.slice(lastColon + 1))
  ) {
    return `http://[${endpoint.slice(0, lastColon)}]:${endpoint.slice(lastColon + 1)}`;
  }

  return `http://${endpoint}`;
}

function chooseEndpoint(server, mode) {
  const joinUrl = `https://cfx.re/join/${server.EndPoint}`;
  if (mode === "join") return joinUrl;

  const direct = (server.Data.connectEndPoints || []).find(
    isUsableDirectEndpoint,
  );
  return direct ? normalizeDirectEndpoint(direct) : joinUrl;
}

function spreadsheetSafe(value) {
  const text = String(value);
  return /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const text = spreadsheetSafe(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function makeCsv(rows) {
  const lines = ["name,endpoint"];
  for (const row of rows) {
    lines.push(`${csvCell(row.name)},${csvCell(row.endpoint)}`);
  }
  return `${lines.join("\r\n")}\r\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  process.stdout.write("Downloading the public Cfx.re server directory...\n");
  const feed = await downloadDirectory();
  const listedServers = decodeDirectory(feed);

  const fiveMServers = listedServers.filter(
    (server) => (server.Data.vars || {}).gamename === "gta5",
  );

  const seenIds = new Set();
  let candidates = [];
  const reasonCounts = {
    locale: 0,
    metadata: 0,
  };

  for (const server of fiveMServers) {
    if (seenIds.has(server.EndPoint)) continue;
    seenIds.add(server.EndPoint);

    const evidence = danishEvidence(server, options.strictLocale);
    if (evidence.length === 0) continue;

    if (evidence.includes("locale")) reasonCounts.locale += 1;
    else reasonCounts.metadata += 1;

    candidates.push({ server, evidence });
  }

  const danishCandidateCount = candidates.length;
  let resourceCheckFailures = 0;
  let resourceFailureDetails = [];

  if (options.resource) {
    process.stdout.write(
      `Checking ${danishCandidateCount.toLocaleString("en-US")} Danish listings for resource ${options.resource}...\n`,
    );
    const filtered = await requireResource(candidates, options.resource);
    candidates = filtered.candidates;
    resourceCheckFailures = filtered.failedChecks;
    resourceFailureDetails = filtered.failureDetails;

    if (resourceCheckFailures > 0) {
      const failedIds = resourceFailureDetails
        .map((failure) => failure.id)
        .join(", ");
      throw new Error(
        `Resource verification was incomplete for ${resourceCheckFailures} ` +
          `server(s): ${failedIds}. The existing CSV was not replaced.`,
      );
    }
  }

  const matched = candidates.map(({ server }) => ({
    name: cleanName(server),
    endpoint: chooseEndpoint(server, options.endpoint),
  }));

  const collator = new Intl.Collator("da-DK", {
    numeric: true,
    sensitivity: "base",
  });
  matched.sort(
    (a, b) =>
      collator.compare(a.name, b.name) ||
      collator.compare(a.endpoint, b.endpoint),
  );

  // Two directory IDs can occasionally describe the same visible server.
  // Collapse only exact name+endpoint duplicates so distinct instances remain.
  const uniqueRows = matched.filter(
    (row, index, rows) =>
      index === 0 ||
      row.name !== rows[index - 1].name ||
      row.endpoint !== rows[index - 1].endpoint,
  );

  const outputPath = path.resolve(options.output);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, makeCsv(uniqueRows), "utf8");

  process.stdout.write(
    [
      `Scanned ${listedServers.length.toLocaleString("en-US")} public Cfx.re listings.`,
      `Checked ${fiveMServers.length.toLocaleString("en-US")} FiveM listings.`,
      `Matched ${danishCandidateCount.toLocaleString("en-US")} Danish listings ` +
        `(${reasonCounts.locale} by locale, ${reasonCounts.metadata} by metadata).`,
      options.resource
        ? `Kept ${matched.length.toLocaleString("en-US")} listing(s) using resource ${options.resource}.`
        : "No resource filter was requested.",
      options.resource && resourceCheckFailures > 0
        ? `Excluded ${resourceCheckFailures.toLocaleString("en-US")} listing(s) whose resource list could not be verified.`
        : options.resource
          ? "All requested resource checks completed."
          : "Resource verification was not requested.",
      resourceFailureDetails.length > 0
        ? `Unverified server IDs: ${resourceFailureDetails.map((failure) => `${failure.id} (${failure.message})`).join(", ")}`
        : "No server IDs were left unverified.",
      `Prepared ${uniqueRows.length.toLocaleString("en-US")} unique CSV rows.`,
      matched.length === uniqueRows.length
        ? "No exact duplicate rows were present."
        : `Removed ${(matched.length - uniqueRows.length).toLocaleString("en-US")} exact duplicate row(s).`,
      `Wrote ${outputPath}`,
      "",
    ].join("\n"),
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  chooseEndpoint,
  cleanName,
  danishEvidence,
  decodeDirectory,
  makeCsv,
  parseArgs,
};
