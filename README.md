# signalk-polar-builder

A Signal K server plugin that builds a **self-expanding polar diagram**
(boat speed vs. True Wind Speed / True Wind Angle) purely by watching
live data go by. There's nothing to type in by hand — it learns your
boat's actual performance over time.

## How it works

1. **Subscribes** to `navigation.speedThroughWater` (or SOG),
   `environment.wind.speedTrue`, `environment.wind.angleTrueWater` (or
   `angleTrueGround`), `navigation.rateOfTurn`, and `propulsion.*.state`
   / `propulsion.*.revolutions` (any engine instance).
2. **Engine gate**: if any engine is running — reported via
   `propulsion.*.state !== 'stopped'` or RPM above a threshold — no
   samples are recorded at all. It also waits a full stability window
   after the engine stops before trusting the data again, so
   motor-assisted speed can't leak into the table right at the moment
   you cut the engine.
3. Every second it looks at a rolling window (default 12s) of the wind/
   speed data and checks whether the boat is in **steady state**: low
   standard deviation on boat speed, TWS, and TWA, and a low rate of
   turn. This filters out tacks, gusts, luffing, and other noise so
   only "settled" sailing gets recorded.
4. When conditions are stable (and the engine is off), it buckets the
   mean TWS/TWA (e.g. to the nearest 2 kt / 5°) and records the mean
   boat speed into a **sparse map** keyed by that bucket pair. There's
   no fixed-size grid — a new cell is created the first time a TWS/TWA
   combination is seen, which is what makes the table
   "self-expanding": light air and heavy air, close-hauled and
   downwind, all just show up as the boat sails through them.
5. Each cell keeps a small rolling sample buffer, from which it reports
   a configurable percentile (default 90th) as the "polar" speed — this
   is a common VPP-analysis trick to reject bad helming without
   throwing away all the noise-free data the way taking a strict max
   would.
6. The table is periodically persisted to disk in the plugin's Signal K
   data directory (`polars.json`) and reloaded on restart, so it keeps
   improving across seasons rather than starting from scratch each time.

### Signed vs. unsigned TWA

By default TWA is folded to its absolute value (0–180°), assuming
port/starboard symmetry — this halves the data needed to fill out a
symmetric table. Set `useSignedTwa` to keep port (negative) and
starboard (positive) separate instead, e.g. for a boat with an
asymmetric spinnaker setup and a strong preferred gybe.

## Configuration

All of this is exposed as plugin config in the Signal K admin UI:

| Option | Default | Meaning |
|---|---|---|
| `speedSource` | `navigation.speedThroughWater` | Which speed path to use for BSP |
| `windAngleSource` | `environment.wind.angleTrueWater` | Which TWA path to use |
| `useSignedTwa` | `false` | Keep port (-)/starboard (+) separate instead of folding to 0-180° |
| `engineRpmThreshold` | 100 RPM | Treat any engine as "running" above this speed |
| `twsBucketSize` | 2 kt | Resolution of the TWS axis |
| `twaBucketSize` | 5° | Resolution of the TWA axis |
| `stabilityWindowSeconds` | 12 | How much history is examined per stability check |
| `sampleIntervalSeconds` | 8 | Minimum gap between recorded samples while stable |
| `maxSpeedStdDev` | 0.3 kt | Max BSP std-dev in-window to call it stable |
| `maxTwsStdDev` | 0.7 kt | Max TWS std-dev in-window to call it stable |
| `maxTwaStdDev` | 4° | Max TWA std-dev (circular) in-window to call it stable |
| `maxRateOfTurn` | 3°/s | Max turn rate to call it stable |
| `minTws` / `maxTws` | 2 / 40 kt | Ignore data outside this TWS range |
| `minBsp` | 0.3 kt | Ignore data below this speed (filters moored/anchored) |
| `samplesPerCell` | 50 | Rolling sample buffer size per cell |
| `percentile` | 90 | Percentile used for the reported polar speed |
| `persistIntervalSeconds` | 30 | How often the table is saved to disk |
| `publishPerformanceData` | `true` | Publish live `performance.*` Signal K deltas (see below) |
| `performanceDampingSeconds` | 15 | Server-side TWS damping for published performance data — separate from the webapp's own slider |

Tighten the std-dev thresholds if you want a "purer" polar (fewer, more
reliable points); loosen them if your instruments are noisy and you're
struggling to ever hit "stable".

## REST API

Once installed and started, the plugin exposes:

- `GET /plugins/polar-builder/profiles` — list stored profiles
  (`id`, `name`, `cellCount`, `createdAt`, `lastUpdated`) and which one is
  active (receiving live-recorded samples)
- `POST /plugins/polar-builder/profiles` `{name}` — create a new (empty)
  profile and make it active
- `POST /plugins/polar-builder/profiles/:id/activate` — switch which
  profile live recording writes to
- `DELETE /plugins/polar-builder/profiles/:id` — delete a profile (refused
  if it's the only one left)
- `GET /plugins/polar-builder/polar.json` — raw sparse cell list
  (`tws`, `twa`, `count`, `avgBsp`, `maxBsp`, `polarBsp`, `lastUpdated`)
- `GET /plugins/polar-builder/polar/matrix` — dense matrix keyed by the
  TWS/TWA buckets actually observed so far
- `GET /plugins/polar-builder/polar/csv` — the same matrix as CSV
  (TWA rows × TWS columns), handy for importing into a chart or another
  VPP/routing tool
- `GET /plugins/polar-builder/polar/export?format=csv|pol` — same matrix
  as a downloadable file, comma-separated (`csv`) or tab-separated in the
  common "ORC-style" `.pol` shape most routing tools accept (`pol`)
- `POST /plugins/polar-builder/polar/import?mode=replace|merge` — import a
  CSV or `.pol` TWA×TWS matrix (raw text body); delimiter is auto-detected
- `GET /plugins/polar-builder/polar/status` — current stability state,
  active profile, engine state per instance, and cell count, useful for a
  debug widget
- `GET /plugins/polar-builder/inputs` — every subscribed path with its
  required/active state and current value, backing the webapp's Inputs
  panel
- `POST /plugins/polar-builder/polar/reset` — wipes the table and
  starts learning again

All of the `polar.json`/`polar/matrix`/`polar/csv`/`polar/export`/`polar/reset`
endpoints accept an optional `?profile=<id>` to target a specific profile
instead of the active one (e.g. to export or view a profile without
switching what's currently recording).

## Performance data

Beyond its own REST API, the plugin actively publishes standard Signal K
`performance.*` deltas onto the bus, so any generic Signal K consumer —
instrument gauges, chart plotters, or the `sk-to-nmea0183`/`sk-to-nmea2000`
gateway plugins if you run one — can display them with no knowledge of
this plugin specifically. No NMEA-specific code lives here; publishing the
standard path is what lets those gateway plugins pick it up for free.

| Path | Meaning |
|---|---|
| `performance.velocityMadeGood` | Current VMG from raw BSP/TWA. Positive = upwind, negative = downwind. |
| `performance.polarSpeed` / `.polarSpeedRatio` | Polar-table speed at the current TWS/TWA, and actual-speed-vs-polar ratio. |
| `performance.beatAngle` / `.beatAngleVelocityMadeGood` / `.beatAngleTargetSpeed` | Best-VMG **upwind** angle for the current TWS, its VMG, and — the upwind target speed. |
| `performance.gybeAngle` / `.gybeAngleVelocityMadeGood` / `.gybeAngleTargetSpeed` | Same, **downwind** — the downwind target speed. |
| `performance.targetSpeed` / `.targetAngle` | Whichever of beat/gybe currently applies — the single target-speed value for a simple gauge. |
| `performance.tackTrue` / `.tackMagnetic` | Heading on the opposite tack right now (`heading + 2×TWA`), published whenever `navigation.headingTrue`/`headingMagnetic` is available on the bus — independent of the polar table. |

All polar-derived paths (everything except `velocityMadeGood` and the tack
headings) need at least one recorded cell in the **active** profile;
nothing is published for a path that isn't computable yet — Signal K
convention is to omit an unknown value, not send a placeholder. The TWS
used to pick a polar-table column is smoothed with its own server-side
`performanceDampingSeconds` EMA (default 15s) so gauges don't jump every
gust — a separate control from the webapp's own damping slider, since one
drives a live bus feed and the other a chart. Values keep publishing while
motoring or outside a stability window (the engine/stability gate only
protects what gets *recorded* into the table, not what gets *reported* as
current performance). Set `publishPerformanceData` to `false` if you're
already running another performance-data source (e.g.
`signalk-derived-data`) and want to rely on Signal K's source-priority
instead.

`navigation.attitude` (heel) is subscribed to and captured for possible
future use, but `performance.leeway` isn't published yet — the standard
`k × heel / speed²` approximation needs a boat-specific calibration
constant this plugin has no principled way to default, and an unverified
sign convention there could actively mislead rather than just be absent.

## Webapp

The **Inputs** panel lists every Signal K path this plugin subscribes to —
boat speed, true wind speed/angle, rate of turn, heading (true/magnetic),
heel/attitude, and each detected engine instance — with a status dot (green
= data flowing, red = required but missing, gray = optional and not
present) plus the live value once available. Boat speed, true wind speed,
and true wind angle are marked required (`*`) since nothing gets recorded
or published without them; everything else just enables one specific
enhancement (engine detection, tack heading, etc.) and the plugin works
fine without it. Backed by `GET /plugins/polar-builder/inputs`, polled
every few seconds — useful for spotting a wiring/config problem (wrong
`speedSource`, an instrument not actually reporting) at a glance instead of
wondering why the table stays empty.

Once installed and enabled, open `http://<your-server>/signalk-polar-builder/`
for a live view: the learned boat-speed-vs-TWA curve, interpolated for the
current true wind speed. Because raw TWS jumps around with every gust, the
speed used to pick the curve is smoothed with an exponential moving average
(default 18s time constant, adjustable with a slider on the page and
remembered across reloads) — a small dot shows the actual instantaneous
wind/speed position for comparison against the smoothed curve. Dashed
**VMG laylines** mark the best upwind and downwind angles on that same
damped curve (the TWA that maximizes/minimizes `BSP × cos(TWA)`), mirrored
to both sides when TWA is unsigned, or computed independently per side
when `useSignedTwa` is on.

Each recorded true wind speed also has its own checkbox, shown as a legend
row under the chart — checking one draws its exact, non-interpolated curve
in its own color, labeled directly on the chart with its TWS value, so you
can compare several wind speeds at once instead of only the current damped
one. Unchecking a band hides its curve completely. Among the bands left
checked, the one closest to the current damped TWS is drawn at full
strength and labeled; the rest are faded (visible for context, unlabeled)
so the chart reads as "here's roughly where you are" rather than a flat
pile of equally-weighted lines. Untick "Live conditions" to hide the
damped curve/laylines/live dot and look at stored data alone.

### Profiles

The plugin can hold several independent polar tables at once — e.g. one
per sail configuration, or a manufacturer's polar kept alongside your own
learned one. Exactly one profile is **active** at a time and receives
live-recorded samples; the others are frozen until reactivated. The
webapp's Profile panel lets you switch which profile you're *viewing*
independently of which one is *active*, create new profiles, reactivate
an existing one, or delete one — all backed by the `/profiles` REST
endpoints above. A fresh install starts with a single `default` profile.
Deleting a profile shows an inline "are you sure" prompt with its own
Yes/Cancel buttons rather than a native browser confirm dialog, since
`window.confirm()` is unreliable (sometimes silently auto-dismissed) inside
embedded/kiosk webviews like a chartplotter's browser.

### Import / export

The Import/export panel exports the viewed profile as CSV or a
tab-delimited `.pol` file (the common TWA×TWS matrix shape used loosely by
Expedition, qtVlm, OpenCPN's routing plugin, and referred to informally as
an "ORC-style" polar, since ORC certificates present tables in the same
shape) — either downloads directly from the browser. Importing accepts the
same shapes back (delimiter is sniffed automatically, not read from the
file extension), in **Replace** mode (wipes the profile first) or
**Merge** mode (only overwrites the imported buckets). Imported points are
stored at the file's own TWA/TWS values rather than re-bucketed to your
configured `twsBucketSize`/`twaBucketSize` — if you want future live
samples to blend into the same cells as an imported table, set your bucket
sizes to match the table's grid. If the profile you're importing into
already has any cells, the same inline confirmation used for delete asks
you to confirm first (Replace warns it will erase existing cells, Merge
warns it may overwrite some); importing into an empty profile needs no
confirmation.

## Install

Copy this directory into your Signal K server's `node_modules` (or
`~/.signalk/node_modules`) as `signalk-polar-builder`, or publish it and
install via the Signal K App Store / `npm install`. Restart the server,
enable "Self-Expanding Polar Diagram Builder" under Server → Plugin
Config, and go sailing — the table fills in on its own.

## Testing against your local Signal K server

You don't need to go sailing to see it work — `test/inject-test-data.js`
connects to your server's delta websocket and feeds it synthetic wind,
speed, and engine data. It requires Node 22+ (uses the built-in
`WebSocket` and `fetch` globals, no extra install needed).

All of the `inject-*.js` scripts below switch recording to a dedicated
**`test`** profile before sending any data (creating it first if it
doesn't exist yet), so synthetic data never lands in your real `default`
polar. Switch back to `default` afterward — via the webapp's Profile
panel or `curl -X POST http://localhost:3000/plugins/polar-builder/profiles/default/activate` —
when you're done testing and ready to go sailing for real.

1. **Install the plugin into your server.** From your `signalk-server`'s
   data directory (usually `~/.signalk`):
   ```bash
   cd ~/.signalk/node_modules
   ln -s /path/to/signalk-polar-builder signalk-polar-builder
   ```
   (a symlink via `npm link` works too, and means you don't have to
   re-copy after every edit)

2. **Restart signalk-server**, then open the admin UI
   (`http://localhost:3000/admin`) → Server → Plugin Config →
   enable **Self-Expanding Polar Diagram Builder** → Submit.

3. **If Security is enabled** on your server, turn it off for local
   testing (Server → Security → Settings), since the injector script
   sends deltas as an anonymous client over the main stream.

4. **Run the injector** from the plugin directory:
   ```bash
   node test/inject-test-data.js
   # or against a non-default host/port:
   SK_HOST=192.168.1.50 SK_PORT=3000 node test/inject-test-data.js
   ```
   It runs two phases: 5s with the engine "running" (expect the cell
   count to stay at 0), then 45s of steady simulated sailing at TWS
   14kt / TWA 40° / BSP 6.4kt with the engine "stopped" — the plugin
   should start recording cells partway through phase 2, once a full
   stability window has elapsed since the (simulated) engine stopped.
   It polls `/polar/status` every 5s so you can watch the cell count
   grow live.

5. **Inspect the results directly:**
   ```bash
   curl http://localhost:3000/plugins/polar-builder/polar.json
   curl http://localhost:3000/plugins/polar-builder/polar/matrix
   curl http://localhost:3000/plugins/polar-builder/polar/csv
   curl http://localhost:3000/plugins/polar-builder/polar/status
   curl -X POST http://localhost:3000/plugins/polar-builder/polar/reset   # wipe and retry
   ```

6. **For a faster/looser test run**, you can temporarily relax the
   plugin config in the admin UI before injecting — e.g.
   `stabilityWindowSeconds: 4`, `sampleIntervalSeconds: 2` — so you
   don't have to wait through the full default 12s window each time.
   Put the defaults back afterward.

7. **To check the signed-TWA option**, enable `useSignedTwa` in the
   plugin config, reset the table, and rerun the injector — the
   resulting cell's `twa` should come back as `40` (not folded), and
   if you edit the script to use a negative `twaDeg` you'll see a
   separate negative-bucket cell rather than it merging with the
   positive one.

8. **To see the webapp's chart actually build out** (rather than the one
   or two isolated points the scripts above produce), run
   `node test/inject-realistic-polar.js` instead — it steps through 4
   wind speeds x 7 wind angles (~8.5 minutes at default settings) with a
   plausible hand-picked cruiser-racer polar. Open
   `http://localhost:3000/signalk-polar-builder/` while it runs to watch
   the curve and VMG laylines fill in live.

9. **To check profiles and import/export**, run `node test/test-profiles.js`
   — a fast, fetch-only (no websocket) script that creates a couple of
   temporary profiles, seeds them via `/polar/import`, confirms they stay
   isolated from each other, round-trips an export back through import,
   and cleans up after itself.

10. **To check the published `performance.*` deltas**, run
    `node test/inject-performance-check.js` — seeds a temporary `perf-test`
    profile via import (fast, no waiting through the stability gate),
    subscribes to `performance.*` on the same websocket it injects data
    over, and asserts `beatAngleTargetSpeed`/`gybeAngleTargetSpeed` both
    appear and differ, `velocityMadeGood`'s sign flips between an upwind
    and downwind heading, and `tackTrue` matches the expected
    `heading + 2×TWA` formula.

## Notes / things you may want to extend

- Engine detection relies on `propulsion.*.state` and/or
  `propulsion.*.revolutions` being populated by your engine
  instrumentation (e.g. NMEA 2000 engine data, a RPM sensor, or a
  manual toggle). If your boat has no propulsion data source at all,
  the plugin has no way to know the engine is running and won't filter
  motoring data — the REST `/polar/status` endpoint always reports
  what it's currently seeing per engine instance so you can check this.
- Heel angle is subscribed to (`navigation.attitude`) but not yet used —
  see [Performance data](#performance-data) for why `performance.leeway`
  isn't published. Current and sea state aren't accounted for at all —
  all of these affect boat speed and could be added as extra
  stability/bucket dimensions, or a leeway calc with a calibrated
  constant, if you have the data and want to extend this.
- The percentile-based cell value is intentionally conservative to
  reduce the effect of poor helming; the raw `avgBsp` and `maxBsp` are
  also stored per cell if you'd rather use those.
