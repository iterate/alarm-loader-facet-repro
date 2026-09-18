# Durable Object alarm → Worker Loader facets: calls fail in blocks

**When you run this you expect every facet call to succeed. Sometimes every call in an alarm fails.**

`src/index.js` is the whole program. Thirty Durable Objects, six in each of five regions (location hints), each wake on their own alarm every 60 s.
Inside `alarm()` each one starts 20 facets whose class comes from a Worker Loader (dynamic worker)
and calls `ping()` on each: ten from a plain dynamic worker, ten from one whose `env` carries a stub
of the worker's own `WorkerEntrypoint` (with props), the way our production worker's facets do.

Expected, every alarm:

```
2026-09-18T09:01:00.812Z alarm 1 instance 6d21a6f3: plain ok | env ok
```

Sometimes (real lines, object `weur-2`, 2026-09-18):

```
2026-09-18T16:01:29.422Z alarm 124 instance 1424694c: plain ok | env ok
2026-09-18T16:04:03.573Z alarm 125 instance d65d1222: plain 10/10 FAILED: internal error; reference = 4f4r7cgj5qomq11vmhb2gc1f | env 10/10 FAILED: Unable to deserialize cloned data due to invalid or unsupported version.
2026-09-18T16:05:03.584Z alarm 126 instance b6da9452: plain 10/10 FAILED: internal error; reference = 9k40hh2hja7falg3ai80asal | env 10/10 FAILED: Unable to deserialize cloned data due to invalid or unsupported version.
2026-09-18T16:06:03.591Z alarm 127 instance 41e08174: plain 10/10 FAILED: internal error; reference = b3032qc6mup298jn6er90rlh | env 10/10 FAILED: Unable to deserialize cloned data due to invalid or unsupported version.
2026-09-18T16:07:03.600Z alarm 128 instance d460f073: plain 10/10 FAILED: internal error; reference = gr2lk2omb10d395npi3jqtc5 | env 10/10 FAILED: Unable to deserialize cloned data due to invalid or unsupported version.
```

Note the gap: alarm 125 came 2 min 34 s after alarm 124 instead of 60 s. Four alarms in a row
failed, each in a fresh instance; from alarm 129 (16:08:03) on the object was fine again. The other
29 objects, and the 30 on a second account, were fine at the same minutes.

Every call in the alarm rejects at once. The plain facets reject with `internal error` (a new
reference id per call); the facets whose dynamic worker has an `env` stub reject with V8's
`Unable to deserialize cloned data due to invalid or unsupported version.` — the same failure at
facet start, two spellings. The facet's constructor never runs. The object is usually fine on its
next alarm; sometimes it stays broken for a few.

The `instance` value is a fresh random id per constructed object: it shows every alarm woke a new
object, so the facets are started inside an alarm that is the first thing the object does.

## Run it

```sh
npm install
npx wrangler deploy      # prints https://alarm-loader-facet-repro.<subdomain>.workers.dev
curl https://alarm-loader-facet-repro.<subdomain>.workers.dev/    # starts the thirty objects
```

Come back later and open the same URL: one line per alarm per object. It runs for 24 hours on its
own and then stops. It does not reproduce in local `wrangler dev`.

## How often, and what we know

The failure comes in windows. Across 13 hours on one account, three versions of this program with
27 objects between them saw windows at 20:17–20:23, 20:20, 20:36, 20:48–20:49, 21:29–21:36,
21:58–22:10 and 01:42–01:43 UTC (2026-09-17/18): about every 30 minutes for two hours, then a gap
of three and a half hours. Inside a window several objects fail in the same second, always all
their calls, and objects on other machines are untouched; the same second can hit two different
Workers on the account. Ten objects for a few hours has been enough to catch it every time.

What we ruled out by running variants side by side inside the same alarm (so they share the process
and the window): module size, `ctx.props` reads, facet SQLite use, structured arguments, minting
the class before `ctx.facets.get`, an async code callback, compatibility flags, one loader entry
per facet or per object, twelve objects waking in the same second. All fail together when a window
hits, and none fails otherwise. The only thing that changes anything is the `env` stub, and it only
changes the message.

On our production worker the V8 spelling is the one we see (its facets always carry the env stub),
it is alarm-only there (0 of 60 request-woken controls, 23 of 60 alarm-woken), and once it has hit,
every facet minted from that loader entry keeps failing until the loader id changes or the object is
evicted. Many-facet alarms there also log
`Internal error in Durable Object storage caused object to be reset; reference = …`.

## Questions for Cloudflare

1. What do the `internal error; reference = …` ids say happened on the facet-start path?
2. When `LOADER.get(id, …).getDurableObjectClass(cls, { props })` is handed to `ctx.facets.get()`
   inside `alarm()`, what is serialized and restored at facet start, and what on the process is
   periodic on a 30-minute-ish cadence that can make every facet start in that process fail for a
   second?
3. Why does a dynamic worker with an `env` stub surface it as a V8 deserialization error?
