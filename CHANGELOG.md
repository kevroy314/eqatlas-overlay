# Changelog

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
