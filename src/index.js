// Expected: every alarm line says "ok". Sometimes: alarms where every facet call fails.
//
// Each object is woken by its own alarm every 90 s. Inside alarm() it starts 20 facets whose class
// comes from a Worker Loader (dynamic worker) and calls ping() on each. Expected: "pong" from all
// 20, every time. Observed on the platform: alarms where all 20 calls reject, on several alarms in
// a row. Visit the worker's URL once to start; visit again to read the log.
import { DurableObject } from "cloudflare:workers";

const facetCode = `
import { DurableObject } from "cloudflare:workers";
export class Facet extends DurableObject {
  ping() { return "pong"; }
}`;

const FACETS = 20;
const OBJECTS = 5;
const EVERY_MS = 90_000; // long enough for the idle object to be evicted between alarms
const ALARMS = 960; // 24 hours, then it stops

export class Repro extends DurableObject {
  // A fresh value each time the platform constructs the object: shows each alarm woke a new one.
  instance = crypto.randomUUID().slice(0, 8);

  facet(i) {
    return this.ctx.facets.get(`facet-${i}`, () => ({
      class: this.env.LOADER.get("facet-code", () => ({
        compatibilityDate: "2026-09-01",
        mainModule: "facet.js",
        modules: { "facet.js": facetCode },
      })).getDurableObjectClass("Facet", { props: { i } }),
    }));
  }

  async start() {
    if (await this.ctx.storage.get("log")) return;
    await this.ctx.storage.put("log", []);
    await this.ctx.storage.setAlarm(Date.now() + EVERY_MS);
  }

  async alarm() {
    const results = await Promise.all(
      Array.from({ length: FACETS }, (_, i) => this.facet(i).ping().then(() => "ok", (error) => error.message)),
    );
    const failed = results.filter((r) => r !== "ok");
    const log = await this.ctx.storage.get("log");
    log.push(
      `${new Date().toISOString()} alarm ${log.length + 1} instance ${this.instance}: ` +
        (failed.length ? `${failed.length}/${FACETS} FAILED: ${failed[0]}` : "ok"),
    );
    await this.ctx.storage.put("log", log);
    if (log.length < ALARMS) await this.ctx.storage.setAlarm(Date.now() + EVERY_MS);
  }

  log() {
    return this.ctx.storage.get("log");
  }
}

export default {
  async fetch(request, env) {
    const objects = Array.from({ length: OBJECTS }, (_, n) => env.REPRO.getByName(`object-${n + 1}`));
    await Promise.all(objects.map((object) => object.start()));
    const logs = await Promise.all(objects.map(async (object, n) => [`object-${n + 1}`, ...(await object.log())].join("\n  ")));
    return new Response(
      `${OBJECTS} objects, each woken by an alarm every ${EVERY_MS / 1000} s; every alarm starts ${FACETS} facets from a Worker Loader class and calls ping() on each.\n` +
        `Expected: every line says "ok". Sometimes: lines where every call FAILED.\n\n${logs.join("\n\n")}\n`,
    );
  },
};
