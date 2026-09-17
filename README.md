# Durable Object alarm + Worker Loader facets: calls fail in blocks

A minimal, deployable harness for an intermittent Cloudflare platform failure:

> A Durable Object is constructed by its **alarm**. Inside `alarm()` it starts N facets whose class
> comes from a **Worker Loader** isolate and calls one method on each. Intermittently **every one of
> those calls rejects**, and the same object keeps failing on its next alarms.

Two presentations of it, same call path:

| where | the rejection |
| --- | --- |
| our production worker (`os-next-prd`, account `04b3b57291ef2626c6a8daa9d47065a7`) | `Error: Unable to deserialize cloned data due to invalid or unsupported version.` — V8's `ValueDeserializer::ReadHeader` error, sticking to the loader entry until the loader id changes or the object is evicted |
| this bare harness (first run, see below) | `internal error; reference = <id>` — a different reference id per facet call, 20 of 20 per alarm, on the object's next alarm too |

It does not reproduce in local `wrangler dev` (workerd). It is **bursty**: this harness caught it in
its first run and then not once in the following hour across ~12,000 facet starts, while our
production worker's logs were quiet in the same hour. So this is a catcher to leave running, not an
on-demand trigger. Leave it armed; when the platform condition is present it records the failure.

## What is here

| file | what it is |
| --- | --- |
| [`src/index.js`](src/index.js) | the whole harness: one Durable Object (`Parent`), one inline dynamic worker (`Facet`), three routes |
| [`wrangler.jsonc`](wrangler.jsonc) | a SQLite-backed Durable Object and a `worker_loaders` binding, nothing else |
| [`runs/2026-09-17-first-run.json`](runs/2026-09-17-first-run.json) | the raw rows of the run that caught it |

- `Parent.facet(i)` starts facet `facet-<i>` with a class from `env.LOADER.get("repro", …).getDurableObjectClass("Facet", { props: { i } })`.
- `Parent.pingFacets(n)` starts `n` of them **at once** and calls `ping()` on each, recording `"ok"` or the rejection message.
- `GET /arm` clears the object and sets an alarm. `alarm()` runs `pingFacets`, stores the row, and re-arms for the next round.
- `GET /control` runs the same `pingFacets` from a request. `GET /results` returns the stored rows.

The `incarnation` field is a fresh random id per constructed object, so each row shows that the
alarm ran as the first act of a fresh object (the platform evicts the idle object between rounds).

## Run it

```sh
npm install
npx wrangler deploy          # any account; prints https://alarm-loader-facet-repro.<subdomain>.workers.dev
```

```sh
U=https://alarm-loader-facet-repro.<subdomain>.workers.dev

curl "$U/arm?id=a&facets=20&rounds=40&delayMs=90000"  # 40 alarms 90 s apart, 20 facets each (an hour)
curl "$U/arm?id=b&facets=20&rounds=40&delayMs=90000"  # a few objects at once is better
curl "$U/arm?id=c&facets=20&rounds=40&delayMs=90000"
# ... come back later; do not call the objects meanwhile
curl "$U/results?id=a"                                 # one row per alarm; look for outcomes that are not "ok"

curl "$U/control?id=z&facets=20"                       # the same facets started by a request, fresh object
```

Use a fresh `id` for every run. The 90 s gap lets the platform evict the object between alarms.

## The run that caught it

2026-09-17, account `376ef7ed81b0573f93524de763666c15`, deployed at 18:52 UTC. Six objects armed
with `facets=20&rounds=3&delayMs=90000` (`t1`–`t3` at 18:53:08, `t4`–`t6` at 18:54:06), each alarm
in a fresh incarnation:

| object | 1st alarm | 2nd alarm | 3rd alarm | request at 19:01:20 |
| --- | --- | --- | --- | --- |
| t1 | 18:54:37 ok 20/20 | 18:56:08 **fail 20/20** | 18:57:38 **fail 20/20** | ok 20/20 |
| t2 | 18:54:38 ok 20/20 | 18:56:08 **fail 20/20** | 18:57:38 **fail 20/20** | ok 20/20 |
| t3 | 18:54:39 ok 20/20 | 18:56:09 **fail 20/20** | 18:57:39 **fail 20/20** | ok 20/20 |
| t4 | 18:55:35 ok 20/20 | 18:57:05 ok 20/20 | 18:58:35 ok 20/20 | **fail 20/20** |
| t5 | 18:55:35 ok 20/20 | 18:57:05 ok 20/20 | 18:58:35 ok 20/20 | — |
| t6 | 18:55:36 ok 20/20 | 18:57:06 ok 20/20 | 18:58:36 ok 20/20 | — |

Every failed call rejected with `internal error; reference = …`, a different reference per call
(e.g. `u8vijhqlire5ajelu9pud11c`, `de53sa9oo93p66q1nq800lsc`, `96cbjpvrlms4u1g30tppdhgv`; all 140
are in the JSON). The parent object itself stayed healthy: it stored every row and set the next
alarm. Workers Logs show nothing at error or warn level for the worker in that window; calls into
loader-backed facets do not appear in Workers Logs at all (a `console.log` in the facet's
constructor never shows up, while a `ctx.exports` facet's invocations do).

Objects fail and recover **together in groups** (t1–t3 as one, t4 on its own), which points at state
shared below the object: the process, or the loader's cached entry for `"repro"`, not the object.

## What did not raise the rate (same day, 19:03–19:50 UTC, all zero failures)

| variant | facet starts |
| --- | --- |
| this harness, 20 facets per alarm, six objects, 20 rounds | 2,400 |
| this harness, 50 facets per alarm, three objects, 10 rounds | 1,500 |
| this harness deployed to our production account (`04b3…`), six objects, 20 rounds | 2,400 |
| five variants side by side in the same alarms: bare · 400 KB module · dynamic worker with `env`/`globalOutbound` = a `ctx.exports` WorkerEntrypoint with props + `allow_irrevocable_stub_storage` · facet touching its SQLite · all three | 3,800 |
| per facet a **distinct** loader id with its own 200 KB module (isolates pile up), eight per alarm, five objects, 10 rounds | 400 |
| a retry on the same stub, `ctx.facets.abort` + restart, and a fresh loader id, all recorded per failing facet | never triggered |

So none of module size, a Frankenvalue-carrying `env`, facet storage use, isolate pressure or fan-out
width matters on its own. What matters is a platform condition that comes and goes.

## What our production worker established (120 controlled trials, 2026-09-17, 16:26–17:00 UTC)

- **Alarm only there.** 23 of 60 alarm-woken objects failed, 0 of 60 request-woken controls.
- **Scope is the loader entry.** Once it happened, every facet on that object minted from the same
  `LOADER.get(id)` entry failed — facet names created afterwards and after `ctx.facets.delete` too.
  A facet from a different loader id worked at once in the same object; so did a `ctx.exports`
  facet and a loader-backed `WorkerEntrypoint` with props.
- **Nothing durable is broken.** Retrying, deleting and recreating the facet did not help;
  changing the loader id, an actor reset, or an eviction cleared it at once.
- **Co-symptom.** Many-facet alarm passes also logged
  `Internal error in Durable Object storage caused object to be reset; reference = …`.

## Questions for Cloudflare

1. What do the `internal error; reference = …` ids in `runs/2026-09-17-first-run.json` say
   happened on the facet-call path?
2. When `LOADER.get(id, …).getDurableObjectClass(cls, { props })` is handed to `ctx.facets.get()`
   from inside `alarm()`, what serialized state does facet start create or restore, and what is
   cached per loader entry with what lifetime? Why does a new loader id cure it immediately?
3. Are the storage-reset exceptions the same fault?
