"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  EMPTY_CONFIRMATION,
  parseCsv,
  pushTargets,
  targetsUrl,
} = require("../push-targets.cjs");
const { shouldRun, THREE_DAYS_MS } = require("../should-run.cjs");
const {
  chooseEndpoint,
  danishEvidence,
  makeCsv,
} = require("../scanner.cjs");

test("parses generated CSV including commas, quotes, and embedded newlines", () => {
  const rows = parseCsv(
    'name,endpoint\r\n"Client, One",https://cfx.re/join/abc123\r\n"Client ""Two""\nDK",http://203.0.113.25:30120\r\n',
  );
  assert.deepEqual(rows, [
    { name: "Client, One", endpoint: "https://cfx.re/join/abc123" },
    { name: 'Client "Two"\nDK', endpoint: "http://203.0.113.25:30120" },
  ]);
});

test("restores a scanner-added spreadsheet safety apostrophe", () => {
  assert.deepEqual(
    parseCsv("name,endpoint\r\n'=Formula,https://cfx.re/join/abc123\r\n"),
    [{ name: "=Formula", endpoint: "https://cfx.re/join/abc123" }],
  );
});

test("rejects a changed header and duplicate endpoints", () => {
  assert.throws(() => parseCsv("server,endpoint\r\n"), /header/i);
  assert.throws(
    () =>
      parseCsv(
        "name,endpoint\r\nOne,https://cfx.re/join/same\r\nTwo,https://cfx.re/join/SAME\r\n",
      ),
    /repeats endpoint/i,
  );
});

test("builds only a clean HTTPS inventory URL", () => {
  assert.equal(
    targetsUrl("https://example.workers.dev/").href,
    "https://example.workers.dev/api/v1/targets",
  );
  assert.throws(() => targetsUrl("http://example.test"), /HTTPS/);
  assert.throws(() => targetsUrl("https://user:pass@example.test"), /clean HTTPS/);
});

test("requires an explicit opt-in before pushing an empty inventory", async () => {
  await assert.rejects(
    pushTargets({
      servers: [],
      serviceUrl: "https://example.workers.dev",
      adminKey: "test-key",
      fetchImpl: async () => {
        throw new Error("must not be called");
      },
    }),
    /ALLOW_EMPTY_TARGETS=true/,
  );
});

test("sends the authenticated full replacement and confirms an empty one", async () => {
  let captured;
  const result = await pushTargets({
    servers: [],
    serviceUrl: "https://example.workers.dev",
    adminKey: "test-key",
    allowEmpty: true,
    fetchImpl: async (url, init) => {
      captured = { url: url.href, init };
      return new Response(JSON.stringify({ updated: true, count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.deepEqual(result, { updated: true, count: 0 });
  assert.equal(captured.url, "https://example.workers.dev/api/v1/targets");
  assert.equal(captured.init.method, "PUT");
  assert.equal(captured.init.headers.Authorization, "Bearer test-key");
  assert.equal(
    captured.init.headers["X-Confirm-Empty-Inventory"],
    EMPTY_CONFIRMATION,
  );
  assert.equal(captured.init.body, '{"servers":[]}');
});

test("runs manually, on first use, and after 72 hours", () => {
  const now = Date.parse("2026-08-24T00:00:00.000Z");
  assert.equal(shouldRun({ state: null, now }), true);
  assert.equal(
    shouldRun({
      state: { lastSuccessfulSync: "2026-08-23T00:00:00.000Z" },
      now,
    }),
    false,
  );
  assert.equal(
    shouldRun({
      state: { lastSuccessfulSync: new Date(now - THREE_DAYS_MS).toISOString() },
      now,
    }),
    true,
  );
  assert.equal(
    shouldRun({
      state: { lastSuccessfulSync: "2026-08-23T00:00:00.000Z" },
      now,
      manual: true,
    }),
    true,
  );
});

test("detects Danish metadata and emits the exact CSV schema", () => {
  const server = {
    EndPoint: "abc123",
    Data: {
      hostname: "[DK] Client One",
      connectEndPoints: [],
      vars: { gamename: "gta5", locale: "da-DK" },
    },
  };
  assert.deepEqual(danishEvidence(server, false), ["locale"]);
  assert.equal(chooseEndpoint(server, "auto"), "https://cfx.re/join/abc123");
  assert.equal(
    makeCsv([{ name: "Client One", endpoint: "https://cfx.re/join/abc123" }]),
    "name,endpoint\r\nClient One,https://cfx.re/join/abc123\r\n",
  );
});
