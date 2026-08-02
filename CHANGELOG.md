# Changelog

## 0.7.2 — 2026-08-01

The 0.7.0 update flow worked but was clunky in two specific ways, both reported from real use.

- **Updates were checked once a day, and only at load.** Having seen a version in the morning, a
  release published an hour later stayed invisible until the next day — the only way to see it was
  to toggle the setting off and on, which forces a fetch. It now re-checks whenever the tab regains
  focus, throttled to once every 15 minutes so an afternoon of tab-switching is still only a handful
  of requests for one small cached file. Clicking the version text checks immediately.
- **Nothing said a reload was needed.** Tampermonkey installs the new script, but the open page goes
  on running the old one — which made a successful update look like it had failed. Following the
  update link now reveals a prompt saying so plainly, with a **Reload now** button, and stating what
  survives: settings and panel positions are kept, the log needs dropping again. It clears itself
  once the running version matches the published one.

Deliberately **not** persisting the log across a reload. It is feasible — the track is small (225 KB
for a 3,838-point session) though the combat events behind the Session panel are not (12.3 MB for a
121 MB log, well past localStorage's 5 MB cap, so it would need IndexedDB). But every doc says
"nothing from the log is ever stored", and quietly reversing that to save one drag-and-drop is a bad
trade. Saying so clearly costs nothing and keeps the promise intact.

Verified the throttle both blocks and permits — no fetch inside the window, exactly one after it
elapses, and none at all while the tab is hidden or update checks are switched off.

## 0.7.1 — 2026-08-01

Fixes [#4](https://github.com/kevroy314/eqatlas-overlay/issues/4) — three reported symptoms, one
root cause.

### The bug: a CSS class name collided with the host page

Our version-list footnote used `class="hint"`. **The Atlas has its own `.hint`** — the floating pill
under the 3D view that reads "scroll to fly toward the cursor…". Ours silently inherited its
`position:absolute`, `border-radius:999px` and `pointer-events:none`, which produced exactly what
was reported:

| Reported | Cause |
|---|---|
| "a small window with too extreme curvature" | inherited `border-radius: 999px` |
| "not clear how to dismiss the bubble" | inherited `position:absolute` detached it from the list |
| "the click for upload passes through … creating a file dialog" | inherited `pointer-events:none`, so clicks fell through to the file-drop zone behind |

Scoping our own selector would not have helped — the *host's* rule is what matches our element — so
the class **name** has to be ours alone. Renamed to `eqt-vhint`, and the other generic names
(`v`, `l`) were namespaced too, since single-letter classes are the same accident waiting to happen.
An audit of every element the overlay creates against every host rule now shows no class collisions
remaining; the only host rules that still match ours are element-level resets (`*`, `a`, `select`).

### Also fixed

- **The versions button now shows as pressed while its list is open.** Reported as "not clear how to
  dismiss" — an untoggled button beside an open list gives no hint that it is the way to close it.
- **`tools/build.py` now refuses to build if a backtick appears inside the CSS template literals.**
  Found while writing the fix: with an even number of backticks the file still *parses* — the first
  closes the literal, the next opens a new one — so `node --check` reports nothing while the
  stylesheet is silently truncated from that point on. This had already bitten twice.

## 0.7.0 — 2026-08-01

Development here is hands-off — a friend runs it, something looks odd, and there is no practical
path from "that's odd" to a filed issue, or off a bad release. These close that loop with **no
backend**, using two things GitHub already provides.

### Update awareness, and rolling back

- The panel's new version row shows the running build and links to the install page when a newer
  one exists.
- **versions** lists recent releases. Each is a **pinned** build that deliberately carries no
  `@updateURL` — which is the whole trick. With one, Tampermonkey would notice the newer release at
  the other end and quietly pull the user back to the version they were trying to escape.
- `tools/build.py` now writes `docs/v/<version>/eqtrail.user.js` and maintains `docs/versions.json`
  on every build; `tools/backfill_pinned.py` generated the six historical ones straight from git
  tags, so the rollback list has history from day one.

### Issue reporting

- **issue** and **idea** open GitHub's own new-issue form, pre-filled with a prompt and a collapsed
  diagnostics block, labelled `bug` or `enhancement`. Verified the prefill survives GitHub's login
  redirect, and the URL stays around 1.7 kB — well inside limits.
- Diagnostics carry version, install flavour, browser, GPU, loaded zone, three.js revision, counts
  and settings. They carry **nothing from the log**: not its contents, not its file name (which
  holds the character name), not coordinates, not session timestamps. Asserted in testing against
  the character name, the server name and the file extension.
- Nothing is transmitted until the reader submits on GitHub, where the whole body is visible and
  editable — which is the real consent gate.

### One honest caveat

This adds **the first outbound request this tool has ever made**: one static JSON file from the
project's own Pages, once a day, with no parameters. The **updates** button switches it off and
restores the fully-offline behaviour of the first six versions. The privacy wording in the README,
the install page and the wiki has been corrected rather than left to imply otherwise.

### Fixed while building it

- The `updates` toggle initially sat in the panels row and pushed `swap X/Y` onto two lines; moved
  to the version row, where it belongs anyway.
- The version text shared a flex row with the buttons and ellipsed `update to 0.8.0` down to `u…`,
  hiding the single most useful thing the row can say. It now has its own line.
- The rollback hint inherited `white-space: nowrap` from the panel and clipped at 311px inside a
  236px box instead of wrapping.

## 0.6.0 — 2026-07-30

### Gap handling

A `/loc` stream is not continuous — the macro stops, you camp a spawn, you fall asleep. Measured on a
real seven-hour session: **58 gaps longer than a minute, totalling 1h50 — 26% of the session.** Played
back as-is that is a quarter of the runtime spent watching a stationary dot.

New **gaps** section in the panel: a mode, a threshold, a fast-forward factor, and which layers it
applies to.

- **skip** — discard the excess beyond the threshold (default).
- **fast fwd** — divide the excess by the factor (default 10×).
- **real** — a gap is time like any other; the previous behaviour.

Playback now runs on a **presentation clock** related to the log clock by a piecewise-linear map,
rather than special-casing skips inside the animation loop. Ordinary intervals map 1:1, gaps map
through the policy, and everything downstream — the shader, the gravestones, the Session stats —
keeps working in honest log time. Measured effect on that session: stepping the playhead in 400 even
increments, `real` covers a uniform 63s of log time per step whether anything is happening or not,
while `skip` drops the median step to 46s and crosses the gaps in single jumps. The time saved goes
to the parts with movement in them.

**"skip" means something deliberately different per layer.** In the animation the gap is *jumped* —
there is nothing to watch. On the heatmap the interval is *capped* at the threshold, not zeroed:
zeroing it would erase a camp from the map, and a camp is the thing the heatmap exists to show. Same
rule, different baseline, because the two layers ask different questions about the same silence.

The **applies to** control (`both` / `path` / `heat`) exists for exactly that tension — verified that
`heat` leaves the animation timeline untouched and `path` leaves the heat weights untouched.

### Fixed

- `maxGap` was documented in the defaults but **never read** — the dwell computation hardcoded 30
  seconds. The gap threshold now genuinely drives it, and the setting is gone.
- Dwell credit is computed per *interval* and split between its two endpoint samples, so a long
  silence is discounted once where it actually occurs rather than twice at both ends.

## 0.5.0 — 2026-07-29

- **Gravestones at each death**, revealed in step with playback so a death appears as the trail
  reaches it. Toggle with **deaths** in the layers row; on by default.
- Placement comes from the `/loc` track at the death's timestamp. Where the surrounding samples are
  close together it interpolates; where they are not — the macro stopped, or you died and stood
  still — it stays on the last known sample rather than inventing a spot halfway to wherever you
  went next. If the nearest sample is further off than `gapBreak`, no stone is placed at all and the
  panel says how many were unplaceable, because a confident marker in the wrong place is worse than
  no marker. Measured across the test logs: 6 of 6 placed in one, and 5 deaths with no nearby `/loc`
  correctly placed as none at all in another, where the panel reads "5 deaths, none placeable" —
  silence there would look like a bug rather than missing data.
- Drawn as a camera-facing sprite from a canvas texture. Deliberately one of three's own materials:
  `SpriteMaterial` already carries the logarithmic-depth chunks this renderer requires, and a
  hand-written shader would silently vanish behind the terrain — the same trap the trail hit in 0.1.

## 0.4.0 — 2026-07-29

- **Accuracy and Evasion**, from the swings the log records: 7,488 landed vs 3,705 missed on the
  way out, 3,615 vs 3,146 coming in, in one real session. Both are running ratios, so they settle
  as the session goes on rather than twitching per fight.
- They plot into **their own band** under the main chart rather than onto a second y-axis. Two
  scales side by side make every crossing point look like a relationship when the crossing is
  really an artifact of the ranges you happened to pick. Percentages already share a natural,
  self-describing 0–100% axis, so the ratios share one axis with each other and none with the
  cumulative curves. The band appears only when a ratio is selected.

## 0.3.0 — 2026-07-29

### Fixed: /loc columns were the wrong way round

Tracks drew rotated because the parser read `Your Location is A, B, C` as north-first. It is
**east-first**. Settled by measurement: group every `/loc` by the zone it was logged in and test
which assignment lands inside that zone's published bounds. Across two clients — EQ Legends and
P1999 Green — east-first fits every zone with samples (8/8 and 8/8); north-first falls outside the
map in 5 of 8 and 3 of 8. After the fix, 100% of a 3,526-sample real track lands inside the zone.

`opts.swapXY` (and a **swap X/Y** button) flips it back for any client that really does print north
first. The synthetic logs in `data/` were regenerated in the corrected order.

### Added

- **Session panel** — nine cards counted from the log (damage dealt/taken, kills, deaths,
  experience, levels, coin, items looted, distance travelled) that count up in step with playback.
  Click a card to add it to the plot; the cumulative curves are revealed as the playhead advances.
  One series shows its own units, several show each as a share of its own total — never a second
  y-axis. Hand-rolled SVG, because Manifest V3 forbids remote code and a bundled chart library
  would outweigh the whole overlay.
- **Both panels drag** by their title bar and remember where they were left.
- **Hide UI** — `H` for our panels, `Shift`+`H` for the site's chrome as well, so the canvas fills
  the window for a screen capture. A corner reminder of the key fades out to stay out of the
  recording and returns on any mouse movement. Deliberately not persisted: a reload always restores
  everything, so a hidden panel can never become a mystery.
- **Settings persist** to `localStorage` as you change them — options, series selection and panel
  positions. Nothing from the log is stored.

### Fixed

- `clear()` now tears down everything the script added — both panels, the reminder, the injected
  stylesheets, the key handler and the animation loop. A second copy (an old install beside a new
  one, or a console paste) wipes the previous one instead of stacking a dead panel on top of a live
  one. Verified by injecting three times: exactly one of each survives.
- A failed `setPointerCapture` no longer aborts a drag.

## 0.2.0 — 2026-07-28

Tested against two real logs (121 MB / 1,573,716 lines / 26 `/loc`s, and 79 MB / 999,925 lines /
239 `/loc`s over 17 zones). Everything below is a consequence of what those files actually contain.

- **Streaming parser.** Logs are read in 4 MiB slices with the partial line carried across the
  boundary, and filtered with `indexOf` before any regex runs — a real log is overwhelmingly combat
  spam. `file.text()` on a 121 MB log would have materialised the whole thing as one JS string and
  then exploded it into a million more. Both files now parse in under three seconds, with progress
  reported in the panel.
- **Visits merged per zone.** A zone gets entered dozens of times in a long log; per-visit segments
  turned 100 Emerald Jungle samples into 37 useless stubs. The picker now lists one entry per zone,
  biggest first, with visit counts, and marks zones the atlas has no map for.
- **Starts on the zone you already have open** if the log has samples there, instead of jumping to
  the largest zone in the file.
- **The ribbon breaks at `gapBreak` (300s).** Merged visits and AFK gaps no longer draw a confident
  straight line across the zone between two unrelated samples. Each run is its own tube; they share
  one material so playback still drives them together.
- Panel reports what was actually drawn — samples in this zone of the file total, runs, and any
  lone samples too isolated to extrude into a ribbon.

## 0.1.0 — 2026-07-28

First release.

- **Animated `/loc` trail.** A hand-built tube carrying per-vertex time and speed, revealed by a
  shader as playback advances: lit head, fading trail behind, faint ghost of the route ahead.
  Colour by time or by speed. Play/pause, scrub, speed control.
- **Dwell heatmap.** `/loc` samples binned into cells and smoothed, drawn as one `InstancedMesh` —
  `relief: flat` paints the ground, higher values extrude it into a 3D relief. Cell height comes
  from the log's own elevation, so on a multi-storey zone the heat lands on the floor you walked.
- **Weighting toggle.** `time` (seconds per cell, with any single sample capped at 30s so one AFK
  gap can't eat the colour range) or `visits` (sample count), for logs whose macro only fires on
  movement. The legend is labelled in real units and switches with the mode.
- **Zone segmentation.** `You have entered <Zone>.` lines split a session into per-zone visits;
  the panel offers a picker and loads the matching Atlas zone.
- **Sub-second spreading.** EQ stamps to the second; same-second runs are distributed evenly across
  that second so playback doesn't stutter.
- **Packaging.** `tools/build.py` emits a self-updating Tampermonkey userscript and an unpacked MV3
  extension into `docs/`, which is also the GitHub Pages install page.
- **Synthetic data.** Two generated logs plus the generator, which raycasts the real zone mesh so
  the fake track lands on real ground.
