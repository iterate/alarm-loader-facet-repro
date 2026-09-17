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

## How often

The failure comes and goes on the platform. In our runs it appeared on the second alarm once
(three of six objects, two alarms each, plus one object on a request 3 minutes later), and then not
at all for the following hour across roughly 12,000 facet starts. Nothing we varied made it more
frequent: module size, an `env` stub with props, facet storage use, one loader entry per facet,
50 facets per alarm, a different account. So leave it running and check back.

It does not reproduce in local `wrangler dev`.
