// The same alarm → Worker Loader facet path as ../src/index.js, but exercising every V8
// serialization boundary the way our production worker does:
//   - the facet reads ctx.props (in its constructor and on every call),
//   - the loader's env carries a ctx.exports WorkerEntrypoint stub with props, minted in the
//     parent's constructor,
//   - on every push the facet calls env.API.get() (which returns an RpcTarget), then calls back
//     INTO the parent object through it while the parent is still inside alarm(),
//   - pushes carry a structured batch and return an object, the facet writes SQLite,
//   - the dynamic worker module is ~250 KB of real code,
//   - three pushes per alarm, 10 facets per object, 10 objects, alarms 75 s apart,
//   - the class minted before ctx.facets.get, from an async code callback that awaits storage.
// Expected: every alarm line says "ok". Sometimes: alarms where calls fail. The message says
// which step failed and how (V8's "Unable to deserialize cloned data…" or "internal error").
import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

const FACETS = 10;
const OBJECTS = 10;
const PUSHES = 3;
const EVERY_MS = 75_000;
const ALARMS = 960; // 24 hours

const bulk = Array.from({ length: 4000 }, (_, k) => `export function f${k}(a) { return a + ${k}; }`).join("\n");
const facetCode = `
import { DurableObject } from "cloudflare:workers";
const step = (what, fn) => { try { return fn(); } catch (e) { throw new Error("[" + what + "] " + e.message); } };
const stepAsync = async (what, fn) => { try { return await fn(); } catch (e) { throw new Error("[" + what + "] " + e.message); } };
export class Facet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.name = step("ctx.props in constructor", () => ctx.props.name);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS checkpoint (n INTEGER PRIMARY KEY AUTOINCREMENT, upto INTEGER, state TEXT)");
  }
  async push(events, range) {
    const name = step("ctx.props", () => this.ctx.props.name);
    const scope = await stepAsync("env.API.get()", () => this.env.API.get());
    try {
      const page = await stepAsync("scope.read()", () => scope.read(range.from, 50));
      await stepAsync("scope.claim()", () => scope.claim(name, Date.now() + 20000));
      this.ctx.storage.sql.exec("INSERT INTO checkpoint (upto, state) VALUES (?, ?)", range.to, JSON.stringify({ name, events: events.length, page: page.length }));
      return { name, reduced: events.length, read: page.length };
    } finally {
      scope[Symbol.dispose]?.();
    }
  }
}
${bulk}`;

// What env.API.get() returns: a scope whose calls go back into the parent object.
class Scope extends RpcTarget {
  constructor(env, object) {
    super();
    this.env = env;
    this.object = object;
  }
  read(after, limit) {
    return this.env.REPRO.getByName(this.object).readEvents(after, limit);
  }
  claim(name, at) {
    return this.env.REPRO.getByName(this.object).claim(name, at);
  }
}

export class Api extends WorkerEntrypoint {
  get() {
    return new Scope(this.env, this.ctx.props.object);
  }
}

export class Repro extends DurableObject {
  instance = crypto.randomUUID().slice(0, 8);
  // Minted in the constructor, baked into every loader entry this object creates (as os-next does).
  api = this.ctx.exports.Api({ props: { object: this.ctx.id.name } });

  facet(i) {
    const name = `facet-${i}`;
    // Minted BEFORE ctx.facets.get (as os-next does); the code callback is async and awaits a
    // storage read inside the alarm before the loader gets the modules (as os-next's does).
    const facetClass = this.env.LOADER.get(`facets-of-${this.ctx.id.name}`, async () => {
      const code = (await this.ctx.storage.get("facet-code")) ?? facetCode;
      return {
        compatibilityDate: "2026-09-01",
        compatibilityFlags: ["no_nodejs_compat", "no_nodejs_compat_v2", "allow_irrevocable_stub_storage"],
        mainModule: "facet.js",
        modules: { "facet.js": code },
        env: { API: this.api },
        globalOutbound: this.api,
      };
    }).getDurableObjectClass("Facet", { props: { object: this.ctx.id.name, name } });
    return this.ctx.facets.get(name, () => ({ class: facetClass }));
  }

  // The two doors the facet reaches back through, while this object is inside alarm().
  async readEvents(after, limit) {
    const events = (await this.ctx.storage.get("events")) ?? [];
    return events.filter((e) => e.n >= after).slice(0, limit);
  }
  claim(name, at) {
    return this.ctx.storage.put(`claim:${name}`, at);
  }

  async start() {
    if (await this.ctx.storage.get("log")) return;
    await this.ctx.storage.put("log", []);
    await this.ctx.storage.setAlarm(Date.now() + EVERY_MS);
  }

  async alarm() {
    // Like a delivery pass: append an event, read the log back, push the tail to every facet, three times.
    const events = (await this.ctx.storage.get("events")) ?? [];
    events.push({ n: events.length ? events.at(-1).n + 1 : 0, at: Date.now(), instance: this.instance, payload: "x".repeat(2000) });
    await this.ctx.storage.put("events", events.slice(-200));
    const batch = events.slice(-50);
    const range = { from: batch[0].n, to: batch.at(-1).n + 1 };
    const failures = [];
    let calls = 0;
    for (let push = 0; push < PUSHES; push++) {
      const results = await Promise.all(
        Array.from({ length: FACETS }, (_, i) => this.facet(i).push(batch, range).then(() => "ok", (error) => error.message)),
      );
      calls += results.length;
      failures.push(...results.filter((r) => r !== "ok"));
      if (push < PUSHES - 1) await scheduler.wait(3000);
    }
    const log = await this.ctx.storage.get("log");
    const distinct = [...new Set(failures.map((m) => m.replace(/reference = \w+/, "reference = …")))].slice(0, 2);
    log.push(
      `${new Date().toISOString()} alarm ${log.length + 1} instance ${this.instance}: ` +
        (failures.length ? `${failures.length}/${calls} FAILED: ${distinct.join(" | ")}` : `ok (${calls} calls)`),
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
    const objects = Array.from({ length: OBJECTS }, (_, n) => env.REPRO.getByName(`heavy-${n + 1}`));
    await Promise.all(objects.map((object) => object.start()));
    const logs = await Promise.all(objects.map(async (object, n) => [`heavy-${n + 1}`, ...(await object.log())].join("\n  ")));
    return new Response(
      `${OBJECTS} objects, each woken by an alarm every ${EVERY_MS / 1000} s; every alarm pushes a batch ${PUSHES} times to ${FACETS} facets from a Worker Loader class; each push reads ctx.props, calls back into the parent through env.API, and writes SQLite.\n` +
        `Expected: every line says "ok". Sometimes: lines where calls FAILED.\n\n${logs.join("\n\n")}\n`,
    );
  },
};
