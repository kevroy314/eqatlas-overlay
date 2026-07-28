# Changelog

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
