// Expected: every alarm line says "ok". Sometimes: alarms where every facet call fails.
//
// Thirty objects, six in each of five regions, are each woken by their own alarm every 60 s. Inside alarm() it starts 20 facets whose class
// comes from a Worker Loader (dynamic worker) and calls ping() on each: ten from a plain dynamic
// worker, ten from one whose env carries a stub of this worker's own entrypoint (as our production
// worker does). Expected: 20 × "pong", every time. Observed: alarms where all 20 calls reject —
// the plain ten with "internal error; reference = …", the env ten with V8's
// "Unable to deserialize cloned data due to invalid or unsupported version." — and the object's
// next alarms may fail the same way. Visit the worker's URL once to start; visit again for the log.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const REGIONS = ["wnam", "enam", "weur", "eeur", "apac"]; // Durable Object location hints
const OBJECTS_PER_REGION = 6;
const EVERY_MS = 60_000; // long enough for the idle object to be evicted between alarms
const ALARMS = 1440; // 24 hours, then it stops

// The dynamic worker: one class, one method. The env variant reads ctx.props and calls env.API.
const plainFacet = `
import { DurableObject } from "cloudflare:workers";
export class Facet extends DurableObject {
  ping() { return "pong"; }
}`;
const envFacet = `
import { DurableObject } from "cloudflare:workers";
export class Facet extends DurableObject {
  async ping() { await this.env.API.ping(); return "pong " + this.ctx.props.name; }
}`;

// What the env variant's dynamic worker gets as env.API: this worker's own entrypoint, with props.
export class Api extends WorkerEntrypoint {
  ping() {
    return "api";
  }
}

export class Repro extends DurableObject {
  // A fresh value each time the platform constructs the object: shows each alarm woke a new one.
  instance = crypto.randomUUID().slice(0, 8);
  api = this.ctx.exports.Api({ props: { object: this.ctx.id.name } });

  facet(kind, i) {
    const name = `${kind}-${i}`;
    return this.ctx.facets.get(name, () => ({
      class: this.env.LOADER.get(`${kind}-code`, () => ({
        compatibilityDate: "2026-09-01",
        mainModule: "facet.js",
        modules: { "facet.js": kind === "env" ? envFacet : plainFacet },
        ...(kind === "env" ? { env: { API: this.api }, globalOutbound: this.api } : {}),
      })).getDurableObjectClass("Facet", { props: { name } }),
    }));
  }

  async start() {
    if (await this.ctx.storage.get("log")) return;
    await this.ctx.storage.put("log", []);
    await this.ctx.storage.setAlarm(Date.now() + EVERY_MS);
  }

  async alarm() {
    const results = {};
    await Promise.all(
      ["plain", "env"].map(async (kind) => {
        results[kind] = await Promise.all(
          Array.from({ length: 10 }, (_, i) => this.facet(kind, i).ping().then(() => "ok", (error) => error.message)),
        );
      }),
    );
    const cell = (kind) => {
      const failed = results[kind].filter((r) => r !== "ok");
      return failed.length ? `${kind} ${failed.length}/10 FAILED: ${failed[0]}` : `${kind} ok`;
    };
    const log = await this.ctx.storage.get("log");
    log.push(`${new Date().toISOString()} alarm ${log.length + 1} instance ${this.instance}: ${cell("plain")} | ${cell("env")}`);
    await this.ctx.storage.put("log", log);
    if (log.length < ALARMS) await this.ctx.storage.setAlarm(Date.now() + EVERY_MS);
  }

  log() {
    return this.ctx.storage.get("log");
  }
}

export default {
  async fetch(request, env) {
    // Objects spread over regions (a location hint places a NEW object there), so one run covers
    // many machines: the failure is a per-machine window.
    const names = REGIONS.flatMap((region) => Array.from({ length: OBJECTS_PER_REGION }, (_, n) => [`${region}-${n + 1}`, region]));
    const objects = names.map(([name, region]) => env.REPRO.get(env.REPRO.idFromName(name), { locationHint: region }));
    await Promise.all(objects.map((object) => object.start()));
    const logs = await Promise.all(objects.map(async (object, n) => [names[n][0], ...(await object.log())].join("\n  ")));
    return new Response(
      `${names.length} objects in ${REGIONS.length} regions, each woken by an alarm every ${EVERY_MS / 1000} s; every alarm starts 10 plain facets and 10 env facets from Worker Loader classes and calls ping() on each.\n` +
        `Expected: every line says "plain ok | env ok". Sometimes: lines where every call FAILED — "internal error" on the plain ten, "Unable to deserialize cloned data" on the env ten.\n\n${logs.join("\n\n")}\n`,
    );
  },
};
