# Durable Object alarm → Worker Loader facets: calls fail in blocks

**When you run this you expect every facet call to succeed. Sometimes every call in an alarm fails.**

`src/index.js` is the whole program. Five Durable Objects each wake on their own alarm every 90 s.
Inside `alarm()` each one starts 20 facets whose class comes from a Worker Loader (dynamic worker)
and calls `ping()` on each. `ping()` returns `"pong"`.

Expected, every alarm:

```
2026-09-17T18:54:37.814Z alarm 1 instance 6d21a6f3: ok
```

Sometimes:

```
2026-09-17T18:56:08.040Z alarm 2 instance 7177bf5c: 20/20 FAILED: internal error; reference = u8vijhqlire5ajelu9pud11c
2026-09-17T18:57:38.244Z alarm 3 instance 192ef84d: 20/20 FAILED: internal error; reference = 96cbjpvrlms4u1g30tppdhgv
```

All 20 calls fail together, each with its own reference id, and the object's next alarms fail the
same way. In our production worker the same call path rejects with V8's
`Unable to deserialize cloned data due to invalid or unsupported version.` instead, and keeps
rejecting for that loader entry until the loader id changes or the object is evicted.

The `instance` value is a fresh random id per constructed object: it shows every alarm woke a new
object, so the facets are started inside an alarm that is the first thing the object does. The same
facets started from a request have never failed.

## Run it

```sh
npm install
npx wrangler deploy      # prints https://alarm-loader-facet-repro.<subdomain>.workers.dev
curl https://alarm-loader-facet-repro.<subdomain>.workers.dev/    # starts the five objects
```

Come back later and open the same URL: it prints one line per alarm per object. It runs for 24
hours on its own and then stops.

## Observed over 5.5 hours (2026-09-17 19:50 to 2026-09-18 01:42 UTC, one account)

| program | objects | alarms | failing alarms | when |
| --- | --- | --- | --- | --- |
| bare (this page) | 5 | 1,171 | 21, all `internal error; reference = …`, all 20 calls each | windows at 20:17–20:23, 20:20, 20:48, 21:29, 21:58: several objects in the same second, then clean again |
| `heavy/` | 10 | 2,399 | 3, all `Unable to deserialize cloned data…`, all 30 calls each | one window, 20:36:15, three objects in the same second |
| nine-variant leave-one-out of heavy's ingredients inside one alarm (not in this repo) | 10 | 2,304 (36 facet starts each) | 0 | — |

Objects that fail together fail in the same second and recover on their next alarm (one object stayed
broken for two alarms, once for four); the windows on the bare program's objects came back about every
30 to 40 minutes. Whatever is wrong is below the object: the process, or the loader's cached entry.

## How often

The failure comes and goes on the platform. In our runs it appeared on the second alarm once
(three of six objects, two alarms each, plus one object on a request 3 minutes later), and then not
at all for the following hour across roughly 12,000 facet starts. Nothing we varied made it more
frequent: module size, an `env` stub with props, facet storage use, one loader entry per facet,
50 facets per alarm, a different account. So leave it running and check back.

It does not reproduce in local `wrangler dev`.

## `heavy/`: the same path with every serialization boundary our production worker crosses

The bare program above fails with `internal error`; our production worker fails on the same path
with V8's deserialize message. The difference is what the facet does. `heavy/src/index.js` makes
the facet do what ours does: read `ctx.props` in its constructor and on every call, get a scope
stub from an `env` entrypoint (a `ctx.exports` WorkerEntrypoint with props, minted in the parent's
constructor and baked into the loader entry), call back into the parent object through that scope
while the parent is still inside `alarm()`, take a structured batch and return an object, write
SQLite, and load a ~250 KB module. Ten objects, ten facets each, three pushes per alarm.

```sh
npx wrangler deploy -c heavy/wrangler.jsonc
curl https://alarm-loader-facet-repro-heavy.<subdomain>.workers.dev/    # start; visit again to read
```

Failure lines name the step that failed, e.g. `[ctx.props] …`; a line with no step prefix means
the call into the facet rejected before the facet's own code ran.

**Reproduced.** 2026-09-17 20:36:15 UTC, account `376ef7ed81b0573f93524de763666c15`, three of ten
objects on the same alarm, all 30 calls each, no step prefix (the facet's constructor never ran):

```
heavy-1   2026-09-17T20:36:15.992Z alarm 15 instance 896c3818: 30/30 FAILED: Unable to deserialize cloned data due to invalid or unsupported version.
heavy-8   2026-09-17T20:36:16.266Z alarm 15 instance 0380f329: 30/30 FAILED: Unable to deserialize cloned data due to invalid or unsupported version.
heavy-10  2026-09-17T20:36:15.407Z alarm 15 instance 81e9c1d6: 30/30 FAILED: Unable to deserialize cloned data due to invalid or unsupported version.
```

The other seven objects were fine on that alarm, and all three were fine on their next one. The
bare program (top of this page) had been failing with `internal error` twelve minutes earlier and
was clean at 20:36. Both programs run on the same account; which objects a bad window hits looks
like a matter of which process they land in.
