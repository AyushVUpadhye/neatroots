import fs from "node:fs";
import http from "node:http";
import { afterEach, expect, it } from "vitest";
import { Roots } from "../src/core.js";
import { defaultConfig } from "../src/config.js";
import { setSecret } from "../src/relay/keychain.js";
import { batch, freePort, hex, s, span, tmpHome, toolSpan } from "./helpers.js";

// Auto-forward ("Every finished run of a project", docs/cloud.md) must survive a failed send and a
// restart: a run that finished while forwarding was on reaches Neatlogs Cloud once, unless the
// person turns forwarding off first.

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

/** A Neatlogs ingest that answers each request with the next status in `statuses` (the last one repeats). */
async function cloud(statuses: number[]): Promise<{ url: string; requests: () => number }> {
  let n = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(statuses[Math.min(n++, statuses.length - 1)]).end());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests: () => n };
}

async function open(home: string, endpoint: string): Promise<Roots> {
  const cfg = defaultConfig();
  cfg.port = await freePort();
  cfg.llm.enabled = false;
  cfg.classifier.backend = "llm";
  cfg.classifier.laya.enabled = false;
  cfg.cloud.endpoint = endpoint;
  cfg.projects["test-agent"] = { forward: true };
  const roots = new Roots({ home, config: cfg, noEngine: true });
  // Wait and retry in milliseconds rather than seconds.
  roots.relay.settleMs = 20;
  roots.relay.retryBaseMs = 20;
  return roots;
}

function newHome(): string {
  const home = tmpHome();
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

/** A run of the test-agent project whose root span has ended. */
function finishRun(roots: Roots): string {
  const t = hex(16);
  const root = hex(8);
  roots.ingest([batch([toolSpan(t, root, "lookup_order", "{}", "{}"), span({ traceId: t, spanId: root, name: "agent", kind: "workflow" })])]);
  return t;
}

async function until(ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const settled = () => new Promise((r) => setTimeout(r, 300));
const statuses = (roots: Roots) => roots.store.listForwards().map((f) => `${f.status}:${f.http_status ?? "-"}`).reverse();

it("retries a run whose auto-forward failed with a 5xx, and sends it once", async () => {
  await setSecret("cloud-api-key", "nl-test-key");
  const c = await cloud([503, 200]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  const t = finishRun(roots);
  await until(() => roots.store.forwardedTraceIds().has(t));
  await settled();
  expect(statuses(roots)).toEqual(["error:503", "ok:200"]);
});

it("doesn't retry a failure that won't pass on its own (a rejected key)", async () => {
  await setSecret("cloud-api-key", "nl-test-key");
  const c = await cloud([401]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  finishRun(roots);
  await until(() => roots.store.listForwards().length > 0);
  await settled();
  expect(c.requests()).toBe(1);
  expect(statuses(roots)).toEqual(["error:401"]);
});

it("stops retrying after a few attempts when ingest keeps failing", async () => {
  await setSecret("cloud-api-key", "nl-test-key");
  const c = await cloud([503]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  finishRun(roots);
  await until(() => roots.store.listForwards().length >= 2);
  await new Promise((r) => setTimeout(r, 1500));
  const tries = c.requests();
  expect(tries).toBeGreaterThan(1);
  expect(tries).toBeLessThanOrEqual(8);
  await settled();
  expect(c.requests()).toBe(tries);
});

it("sends a run that a restart interrupted before it was forwarded", async () => {
  await setSecret("cloud-api-key", "nl-test-key");
  const c = await cloud([200]);
  const home = newHome();
  const first = await open(home, c.url);
  first.relay.settleMs = 60_000; // still waiting when neatroots stops
  const t = finishRun(first);
  first.close();
  expect(c.requests()).toBe(0);

  const second = await open(home, c.url);
  cleanup.push(() => second.close());
  second.relay.resume?.();
  await until(() => second.store.forwardedTraceIds().has(t));
  await settled();
  expect(statuses(second)).toEqual(["ok:200"]);
});

it("doesn't touch the store after neatroots closes with a forward still waiting", async () => {
  await setSecret("cloud-api-key", "nl-test-key");
  const c = await cloud([200]);
  const roots = await open(newHome(), c.url);
  roots.relay.settleMs = 100;
  const rejections: unknown[] = [];
  const onRejection = (e: unknown) => rejections.push(e);
  process.on("unhandledRejection", onRejection);
  cleanup.push(() => void process.off("unhandledRejection", onRejection));
  finishRun(roots);
  roots.close();
  // Past the longest wait before a send, old or new.
  await new Promise((r) => setTimeout(r, 2000));
  expect(rejections).toEqual([]);
  expect(c.requests()).toBe(0);
});

it("drops a queued run when forwarding is turned off before it is sent", async () => {
  await setSecret("cloud-api-key", "nl-test-key");
  const c = await cloud([200]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  roots.relay.settleMs = 200;
  finishRun(roots);
  roots.config.projects["test-agent"] = { forward: false };
  await new Promise((r) => setTimeout(r, 2000));
  expect(c.requests()).toBe(0);
  expect(roots.store.listForwards()).toEqual([]);
});

it("never auto-forwards an imported run (docs/cloud.md)", async () => {
  await setSecret("cloud-api-key", "nl-test-key");
  const c = await cloud([200]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  const t = hex(16);
  const root = hex(8);
  const imported = batch([span({ traceId: t, spanId: root, name: "agent", kind: "workflow" })]);
  imported.resource.attributes.push(s("neatroots.import.source", "file"));
  roots.ingest([imported]);
  expect(roots.store.getRun(t)?.project).toBe("test-agent");
  await new Promise((r) => setTimeout(r, 2000));
  expect(c.requests()).toBe(0);
  expect(roots.store.listForwards()).toEqual([]);
});

it("still auto-forwards a run sent live through the HTTP trace API", async () => {
  await setSecret("cloud-api-key", "nl-test-key");
  const c = await cloud([200]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  const t = hex(16);
  const live = batch([span({ traceId: t, spanId: hex(8), name: "agent", kind: "workflow" })]);
  live.resource.attributes.push(s("neatroots.import.source", "http"));
  roots.ingest([live]);
  await until(() => roots.store.forwardedTraceIds().has(t));
});

it("doesn't send a run again that was already sent by hand", async () => {
  await setSecret("cloud-api-key", "nl-test-key");
  const c = await cloud([200]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  roots.relay.settleMs = 200;
  const t = finishRun(roots);
  expect((await roots.relay.forward([t], "user")).status).toBe("ok");
  const sent = c.requests();
  await new Promise((r) => setTimeout(r, 2000));
  expect(c.requests()).toBe(sent);
  expect(statuses(roots)).toEqual(["ok:200"]);
});
