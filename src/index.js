// A Durable Object that, woken by its alarm, starts N facets whose class comes from a Worker
// Loader isolate and calls one method on each — concurrently, the way a real alarm handler fans
// out. Some of those calls reject with V8's
//   "Unable to deserialize cloned data due to invalid or unsupported version."
// The same facets started by a request (GET /control) never do.
import { DurableObject } from "cloudflare:workers";

// The dynamic worker: one Durable Object class with one method. No state, no bindings, no I/O.
const facetModule = `
import { DurableObject } from "cloudflare:workers";
export class Facet extends DurableObject {
  ping() { return "pong"; }
}`;

export class Parent extends DurableObject {
  // A new value every time the platform constructs the object, so /results shows whether each
  // alarm ran as the FIRST act of a fresh object — the condition under which the bug appears.
  incarnation = crypto.randomUUID().slice(0, 8);

  // Facet `facet-<i>`, started on first use with a class from the loader entry "repro".
  facet(i) {
    return this.ctx.facets.get(`facet-${i}`, () => ({
      class: this.env.LOADER.get("repro", () => ({
        compatibilityDate: "2026-09-01",
        mainModule: "facet.js",
        modules: { "facet.js": facetModule },
      })).getDurableObjectClass("Facet", { props: { i } }),
    }));
  }

  // Start `count` facets at once and call each once: "ok" or the rejection's message, per facet.
  async pingFacets(count) {
    const outcomes = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        this.facet(i).ping().then(() => "ok", (error) => error.message),
      ),
    );
    return { incarnation: this.incarnation, outcomes };
  }

  // Forget everything and set one alarm. Leave the object alone afterwards so the platform evicts
  // it: the alarm then constructs a fresh object whose first act is alarm().
  async arm(facets, rounds, delayMs) {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("run", { facets, rounds, delayMs, results: [] });
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  async alarm() {
    const run = await this.ctx.storage.get("run");
    run.results.push({ at: new Date().toISOString(), ...(await this.pingFacets(run.facets)) });
    await this.ctx.storage.put("run", run);
    if (run.results.length < run.rounds) await this.ctx.storage.setAlarm(Date.now() + run.delayMs);
  }

  results() {
    return this.ctx.storage.get("run");
  }
}

const usage = `GET /arm?id=a&facets=20&rounds=40&delayMs=90000  set the alarms (default: 40, an hour), then leave the object alone
GET /results?id=a                                 one row per alarm; look for messages that are not "ok"
GET /control?id=b&facets=20                       the same facets started by a request: all "ok"
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const number = (name, fallback) => Number(url.searchParams.get(name) ?? fallback);
    const parent = env.PARENT.getByName(url.searchParams.get("id") ?? "default");
    switch (url.pathname) {
      case "/arm": {
        const [facets, rounds, delayMs] = [number("facets", 20), number("rounds", 40), number("delayMs", 90_000)];
        await parent.arm(facets, rounds, delayMs);
        return new Response(`armed: ${rounds} alarm(s) ${delayMs} ms apart, ${facets} facets each\n`);
      }
      case "/results":
        return Response.json(await parent.results());
      case "/control":
        return Response.json(await parent.pingFacets(number("facets", 20)));
      default:
        return new Response(usage, { status: 404 });
    }
  },
};
