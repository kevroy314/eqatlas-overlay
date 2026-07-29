# Changelog

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
