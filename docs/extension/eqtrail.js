(function () {
  'use strict';
  window.__EQTRAIL_BUILD = { version: '0.7.1', flavour: 'extension', pinned: false };
  // app.js publishes window.__dbg at the very END of an ES module, so a userscript or content
  // script running at document-idle can beat it. Poll for it; give up loudly rather than silently.
  var tries = 0;
  var iv = setInterval(function () {
    if (window.__dbg && window.__dbg.THREE) { clearInterval(iv); overlay(); }
    else if (++tries > 300) {
      clearInterval(iv);
      console.error('[EQTrail] window.__dbg never appeared after 30s — either this is not a Zone ' +
                    'Atlas page, or the site stopped publishing its debug handle.');
    }
  }, 100);

  function overlay() {
    /* eqtrail-overlay.js — animated /loc path + dwell heatmap on top of the EQL Zone Atlas.
     *
     * HOW IT ATTACHES
     * ---------------
     * atlas/app.js is an ES module (nothing global) BUT it publishes a debug handle at the end:
     *
     *     window.__dbg = { get Z(), get mode(), cam(), ctl(), scene, setActive, THREE, reticle,
     *                      loadZone, searchZones, get MANIFEST(), locToMesh, meshToLoc, ... }
     *
     * That gives us the live THREE instance (r160), the scene, and the zone record `Z`. We never
     * patch their code — we only add objects. Two rules make the overlay behave like a native layer:
     *
     *   1. COORDINATES. Their transform is the single source of truth:
     *          mesh.x = -east/10 ;  mesh.y = up/10 ;  mesh.z = north/10
     *      /loc prints "east, north, up" — X FIRST, contrary to the usual folklore. See the note
     *      above the parser for how that was measured. We use __dbg.locToMesh for the transform.
     *
     *   2. PARENTING. In the exploded ("floors pulled apart") view app.js lifts each floor band
     *      group: Z.groups[i].position.y = i * gap * lift. Anything added to the raw scene would
     *      float free of its storey. So every overlay object is parented into the band group its
     *      y falls into — the same trick app.js uses for its own markers (placeMarker / bandGroupForY)
     *      — and it then rides the lift, the clip planes and the per-floor visibility for free.
     *
     * PUBLIC API
     *     EQTrail.loadFile(file)  stream a File (the drop path — use this for real, huge logs)
     *     EQTrail.loadLog(text)   same, from a string already in memory
     *     EQTrail.loadPoints(pts) [{t:<epoch seconds>, east, north, up}, ...] — skip the parser
     *     EQTrail.useSegment(i)   switch to another zone found in the log
     *     EQTrail.play() / .pause() / .setT(0..1) / .clear() / .rebuild()
     *     EQTrail.opts            live-tunable options (see DEFAULTS)
     *
     * WHAT A REAL LOG LOOKS LIKE (measured, not assumed)
     *     121 MB · 1,573,716 lines · 26 /locs, all in one zone
     *      79 MB ·   999,925 lines · 239 /locs spread over 12 zones and 300+ visits
     * So: stream the file rather than reading it whole, filter with indexOf before regex, merge a
     * zone's many visits into one series, and break the ribbon wherever the log went quiet.
     */
    (function () {
      'use strict';
      const D = window.__dbg;
      if (!D || !D.THREE) { console.error('[EQTrail] window.__dbg not found — is this the Zone Atlas page?'); return; }
      const T = D.THREE;
      if (window.EQTrail) window.EQTrail.clear();

      const DEFAULTS = {
        // ---- path ----
        tubeRadius: 1.1,        // mesh units (×10 = /loc units). Scaled by zone span on build.
        radialSegments: 7,
        yLift: 0.7,             // nudge above the floor so the ribbon never z-fights the ground
        trail: 0.10,            // how much of the track stays lit behind the head (0..1 of session)
        future: 0.05,           // opacity of the not-yet-walked track (0 = hide it)
        speed: 60,              // playback: log-seconds per wall-second
        colorBy: 'time',        // 'time' | 'speed'
        // ---- heatmap ----
        cell: 9,                // bin size in mesh units
        blur: 1,                // gaussian passes over the density grid
        relief: 0,              // 0 = flat plate on the floor; >0 = extrude into a 3D relief
        heatOpacity: 0.82,
        heatFloor: 0.02,        // drop cells below this fraction of peak (kills the confetti)
        heatOn: true,
        pathOn: true,
        // 'time'   — weight each sample by the gap around it: "how long were you here".
        // 'visits' — weight every sample as 1: "how often did a /loc fire here".
        // Which one is HONEST depends on the macro. A fixed-interval /loc (every N seconds no matter
        // what) makes the two nearly equivalent and 'time' is the better read. A /loc bound to the
        // movement keys emits nothing while you stand still, so 'time' would credit a whole camp to
        // the single sample before you stopped moving — 'visits' is the truthful one there, and it
        // measures traffic, not dwell. Default 'time'; the toggle is in the panel.
        heatBy: 'time',

        // ---- large gaps in the stream ----
        // A /loc stream is not continuous. The macro stops, the player camps a spawn, or falls asleep —
        // and a quarter of a real seven-hour session turns out to be gaps longer than a minute. Played
        // back as-is that is a stationary dot for a quarter of the runtime, and on the heatmap it is one
        // cell soaking up every colour in the ramp.
        //
        //   'real' — a gap is time like any other. Nothing is done.
        //   'ff'   — the excess beyond the threshold is divided by gapFF.
        //   'skip' — the excess beyond the threshold is discarded.
        //
        // 'skip' means something slightly different per layer, on purpose:
        //   · animation — the gap is JUMPED (zero presentation time). There is nothing to watch.
        //   · heatmap   — the interval is CAPPED at the threshold, not zeroed. Zeroing it would erase a
        //     camp from the map entirely, and a camp is exactly the thing the heatmap exists to show.
        // Same rule ("discard the excess"), different baseline, because the two layers are answering
        // different questions about the same silence.
        gapMode: 'skip',
        gapThreshold: 60,       // seconds — above this, an interval counts as a gap
        gapFF: 10,              // 'ff' divisor applied to the excess
        gapApply: 'both',       // 'both' | 'anim' | 'heat' — which layers the policy touches

        // ---- release channel ----
        // The ONLY network request this tool makes. It fetches one static JSON file from the project's
        // own GitHub Pages, sends nothing with it, and is cached for a day. Off means the overlay is
        // once again entirely offline — which is how it shipped for its first six versions, and some
        // people will want it back.
        updateCheck: true,
        // Break the ribbon when consecutive samples are further apart than this. A real log is not a
        // continuous track: the macro stops, you camp, you log out, you come back three days later —
        // and every zone visit gets merged into one series. Without a break the tube draws a confident
        // straight line across the whole zone between two samples that have nothing to do with
        // each other. 5 minutes is long enough to keep a genuine run intact.
        gapBreak: 300,
        // Escape hatch for a client that really does print /loc north-first. Off by default because
        // every log measured so far prints east first; see the note above the parser.
        swapXY: false,
        gravesOn: true,         // a headstone at each death, revealed as playback reaches it
        // ---- statistics ----
        // Which metrics are plotted. Two by default so the chart opens showing what it is FOR — a
        // single curve looks like a decoration, two that diverge look like a question.
        series: ['dmgOut', 'xp'],
      };

      // ============================ colour ramps ============================
      // Both ramps are SEQUENTIAL and monotonic in lightness — dark/low to bright/high — so they
      // read correctly over the atlas's near-black sky and survive greyscale. They are deliberately
      // in different families so a hot cell is never mistaken for a late timestamp:
      //   heat = inferno (magnitude, "how long did you stand here")
      //   time = ice     (a single cool hue climbing to white — "when")
      const RAMPS = {
        inferno: [[0.02,0.01,0.08],[0.23,0.04,0.33],[0.45,0.09,0.42],[0.66,0.17,0.36],
                  [0.85,0.30,0.23],[0.96,0.49,0.10],[0.99,0.70,0.15],[0.99,0.94,0.64]],
        ice:     [[0.03,0.10,0.22],[0.05,0.24,0.42],[0.06,0.40,0.58],[0.09,0.56,0.68],
                  [0.24,0.72,0.75],[0.52,0.85,0.82],[0.78,0.94,0.92],[1.00,1.00,1.00]],
      };
      function ramp(name, u) {
        const s = RAMPS[name]; u = u < 0 ? 0 : u > 1 ? 1 : u;
        const f = u * (s.length - 1), i = Math.min(s.length - 2, Math.floor(f)), k = f - i;
        return [s[i][0] + (s[i + 1][0] - s[i][0]) * k,
                s[i][1] + (s[i + 1][1] - s[i][1]) * k,
                s[i][2] + (s[i + 1][2] - s[i][2]) * k];
      }

      // ============================ log parsing =============================
      // EQ writes one bracketed timestamp per line. The only positional line vanilla EQ emits is /loc.
      //
      // THE ORDER OF THOSE THREE NUMBERS IS "east, north, up" — X FIRST.
      // This is worth stating loudly because the folklore (and the atlas's own source comment) says
      // /loc prints Y first, and reading it that way puts the whole track sideways. It was settled by
      // measurement, not argument: take every /loc in a log, group by the zone it was logged in, and
      // check which assignment lands inside that zone's published bounds. Across two logs from two
      // different clients — EQ Legends and P1999 Green — "east first" fits every zone with samples
      // (8/8 and 8/8); "north first" falls outside the map in 5 of 8 and 3 of 8. If you ever meet a
      // client that really does print north first, `opts.swapXY` flips it back without a code change.
      const RE_LINE = /^\[(\w{3}) (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})\]\s*(.*)$/;
      const RE_LOC  = /^Your Location is\s*(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/i;
      const RE_ZONE = /^You have entered ([^.]+)\./i;
      const MON = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };

      // ---------------------------- statistics ----------------------------
      // What a log actually offers, by volume, from a real session: damage lines dominate, then
      // faction, loot, experience, kills. These nine are the ones that are both common enough to make
      // a curve and meaningful enough to care about. `dist` is the odd one out — it comes from the
      // /loc track itself, not from a line, which is why the map and the chart agree about it.
      const METRICS = [
        { k: 'dmgOut', label: 'Damage dealt',  fmt: 'int'  },
        { k: 'dmgIn',  label: 'Damage taken',  fmt: 'int'  },
        { k: 'kills',  label: 'Kills',         fmt: 'int'  },
        { k: 'deaths', label: 'Deaths',        fmt: 'int'  },
        { k: 'xp',     label: 'Experience',    fmt: 'pct'  },
        { k: 'levels', label: 'Levels',        fmt: 'int'  },
        { k: 'coin',   label: 'Coin',          fmt: 'coin' },
        { k: 'loot',   label: 'Items looted',  fmt: 'int'  },
        { k: 'dist',   label: 'Distance',      fmt: 'dist' },
        // RATIOS. These two are not sums, so they never belong on the cumulative axis — a percentage
        // and a damage total share no scale. They are also not a reason to add a SECOND y-axis to the
        // main chart: two scales side by side make every crossing point look like a relationship, and
        // the crossing is an artifact of whatever ranges you happened to choose. Percentages already
        // have a natural, self-describing 0–100% scale, so they get their own band underneath with a
        // single axis they genuinely share.
        { k: 'acc',    label: 'Accuracy',      fmt: 'ratio', ratio: ['hitOut', 'missOut'] },
        { k: 'eva',    label: 'Evasion',       fmt: 'ratio', ratio: ['missIn', 'hitIn'] },
      ];
      // The dataviz reference's dark categorical slots, in its fixed order — validated against this
      // panel's surface (#15122e): lightness band, chroma floor, CVD separation, contrast all pass.
      // Worst adjacent CVD pair sits at ΔE 8.4, which is legal only with secondary encoding, so every
      // plotted series also carries a direct label in the legend. Colour follows the METRIC, never the
      // order it was picked in, so toggling one series never repaints the others.
      const SERIES_HEX = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'];

      const RE_DMG  = /for (\d+) points? of damage/;
      const RE_HURT = /^You hurt yourself for (\d+) point/;
      const RE_XP   = /^You gain (?:party )?experience!(?:\s*\(([\d.]+)%\))?/;
      const RE_COIN = /^You receive (.+?) from the corpse/;
      const DENOM = { copper: 1, silver: 10, gold: 100, platinum: 1000 };
      function coinToCopper(s) {
        let c = 0;
        const parts = s.match(/(\d+)\s*(platinum|gold|silver|copper)/g) || [];
        for (const p of parts) { const m = /(\d+)\s*(\w+)/.exec(p); c += +m[1] * (DENOM[m[2]] || 0); }
        return c;
      }

      function bump(ev, k, t, v) {
        if (!k) return;                      // an unattributed damage line — count it nowhere rather than wrongly
        const a = ev[k] || (ev[k] = { t: [], v: [] }); a.t.push(t); a.v.push(v);
      }

      // One line of a log. Cheap `indexOf` guards come FIRST: a real log is overwhelmingly combat
      // spam — 1.5 million lines for 26 /locs is a normal ratio — and running regexes over every one
      // of them is the difference between a snappy parse and a hung tab. The outer gate is that every
      // line we care about names the player, as "You"/"Your" or as the target "YOU"; that one test
      // rejects the mob-on-mob and ambient chatter that makes up most of a busy log.
      function eatLine(raw, out, zones, ev) {
        const isLoc = raw.indexOf('Your Location is') >= 0;
        const isZone = !isLoc && raw.indexOf('You have entered') >= 0;
        if (!isLoc && !isZone && raw.indexOf('You') < 0 && raw.indexOf('YOU') < 0) return;
        const m = RE_LINE.exec(raw.charCodeAt(raw.length - 1) === 13 ? raw.slice(0, -1) : raw);
        if (!m) return;
        const t = Date.UTC(+m[7], MON[m[2]], +m[3], +m[4], +m[5], +m[6]) / 1000;
        const b = m[8];
        if (isLoc) {
          const l = RE_LOC.exec(b);
          if (l) out.push({ t, east: +l[1], north: +l[2], up: +l[3] });   // east first — see above
          return;
        }
        if (isZone) {
          const z = RE_ZONE.exec(b);
          if (z) zones.push({ t, name: z[1].trim() });
          return;
        }
        if (!ev) return;
        if (b.indexOf('points of damage') >= 0 || b.indexOf('point of damage') >= 0) {
          const d = RE_DMG.exec(b);
          // "YOU" in caps is how EQ marks the player as the TARGET of a swing; anything else starting
          // with "You " is the player swinging. That single distinction splits the whole combat log.
          if (d) {
            const inbound = b.indexOf(' YOU for ') >= 0;
            const k = inbound ? 'dmgIn' : (b.lastIndexOf('You ', 0) === 0 ? 'dmgOut' : null);
            bump(ev, k, t, +d[1]);
            if (k) bump(ev, inbound ? 'hitIn' : 'hitOut', t, 1);   // the swing itself, for the ratios
          }
          return;
        }
        if (b.lastIndexOf('You try to ', 0) === 0) { bump(ev, 'missOut', t, 1); return; }
        if (b.indexOf(' tries to ') >= 0 && b.indexOf(' YOU, but ') >= 0) { bump(ev, 'missIn', t, 1); return; }
        if (b.lastIndexOf('You have slain', 0) === 0) { bump(ev, 'kills', t, 1); return; }
        if (b.lastIndexOf('You have been slain', 0) === 0) { bump(ev, 'deaths', t, 1); return; }
        if (b.indexOf('experience') >= 0) {
          const x = RE_XP.exec(b);
          if (x) bump(ev, 'xp', t, x[1] ? +x[1] : 0);
          return;
        }
        if (b.lastIndexOf('You have gained a level', 0) === 0) { bump(ev, 'levels', t, 1); return; }
        if (b.indexOf('from the corpse') >= 0) {
          const c = RE_COIN.exec(b);
          if (c) bump(ev, 'coin', t, coinToCopper(c[1]));
          return;
        }
        if (b.indexOf('looted') >= 0 && /^(?:--)?You (?:have )?looted /.test(b)) { bump(ev, 'loot', t, 1); return; }
        if (b.lastIndexOf('You hurt yourself', 0) === 0) {
          const h = RE_HURT.exec(b);
          if (h) bump(ev, 'dmgIn', t, +h[1]);
        }
      }

      function finish(out, zones, ev) {
        out.sort((a, b) => a.t - b.t);
        spreadWithinSecond(out);
        // Event arrays come out of the file in log order, which is chronological — no sort needed,
        // and sorting parallel arrays of half a million entries is not free.
        return { pts: out, zones, ev };
      }

      function parseLog(text) {
        const out = [], zones = [], ev = {};
        for (const raw of text.split('\n')) eatLine(raw, out, zones, ev);
        return finish(out, zones, ev);
      }

      // Real logs are enormous — 121 MB and 1.5 million lines is an ordinary one. Reading that with
      // file.text() materialises the whole thing as a JS string and then split() explodes it into a
      // million more, which is how you get a dead tab. Walk the File in slices instead, carry the
      // partial last line across the boundary, and keep only the handful of lines that matter.
      async function parseFile(file, onProgress) {
        const CHUNK = 4 << 20;                       // 4 MiB — big enough to be cheap, small enough to yield
        const dec = new TextDecoder('utf-8');
        const out = [], zones = [], ev = {};
        let carry = '';
        for (let off = 0; off < file.size; off += CHUNK) {
          const buf = await file.slice(off, off + CHUNK).arrayBuffer();
          // stream:true so a multi-byte character split across the slice boundary survives
          const text = carry + dec.decode(new Uint8Array(buf), { stream: true });
          const lines = text.split('\n');
          carry = lines.pop();                       // last element is a partial line (or '')
          for (let i = 0; i < lines.length; i++) eatLine(lines[i], out, zones, ev);
          if (onProgress) onProgress(Math.min(1, (off + CHUNK) / file.size));
          await new Promise(r => setTimeout(r, 0));  // hand the frame back so playback keeps running
        }
        if (carry) eatLine(carry, out, zones, ev);
        return finish(out, zones, ev);
      }

      // EQ stamps every log line to the SECOND. A /loc macro that fires faster than that (or a burst
      // bound to the movement keys) lands several samples on one identical timestamp, and the playhead
      // then teleports through them in a single frame. Spread each same-second run evenly across its
      // own second — it invents no position, only distributes samples we know fell inside that second.
      function spreadWithinSecond(pts) {
        let i = 0;
        while (i < pts.length) {
          let j = i;
          while (j + 1 < pts.length && pts[j + 1].t === pts[i].t) j++;
          const n = j - i + 1;
          if (n > 1) for (let k = 0; k < n; k++) pts[i + k].t = pts[i].t + k / n;
          i = j + 1;
        }
      }

      // A log usually spans several zones. Split the samples into contiguous per-zone visits so the
      // overlay never draws Blackburrow's track on the Ocean of Tears. Samples before the first
      // "You have entered" line belong to whatever zone they logged in to — unknown, kept as one
      // segment so a log that never zones still works.
      function segmentize(pts, zones) {
        const segs = [];
        let zi = 0, cur = null;
        for (const p of pts) {
          while (zi < zones.length && zones[zi].t <= p.t) {
            cur = null; zi++;                            // a zone line closes the previous segment
          }
          const name = zi > 0 ? zones[zi - 1].name : null;
          if (!cur) { cur = { name, key: name ? zoneKeyForName(name) : null, pts: [] }; segs.push(cur); }
          cur.pts.push(p);
        }
        for (const s of segs) { s.t0 = s.pts[0].t; s.t1 = s.pts[s.pts.length - 1].t; }
        return segs;
      }

      // Then MERGE the visits. A real log crosses the same zone over and over — one file here has 100
      // /locs in the Emerald Jungle spread over 37 separate visits, so per-visit segments would be 37
      // useless three-point stubs. Grouping by zone is the only view that has anything in it; the
      // ribbon is broken at `gapBreak` so merged visits never draw a line between them.
      function groupZones(segs) {
        const by = new Map();
        for (const s of segs) {
          const k = s.key || ('?' + (s.name || 'unknown'));
          let g = by.get(k);
          if (!g) by.set(k, g = { name: s.name, key: s.key, pts: [], visits: 0 });
          for (const p of s.pts) g.pts.push(p);     // not push(...s.pts) — that blows the stack on big arrays
          g.visits++;
        }
        const out = [...by.values()];
        for (const g of out) {
          g.pts.sort((a, b) => a.t - b.t);
          g.t0 = g.pts[0].t; g.t1 = g.pts[g.pts.length - 1].t;
        }
        out.sort((a, b) => b.pts.length - a.pts.length);
        return out;
      }

      // ============================= geometry ===============================
      const rawToMesh = D.locToMesh || ((e, n, u) => new T.Vector3(-e / 10, u / 10, n / 10));
      // Every sample reaches the scene through here, so the swap has exactly one place to live.
      const locToMesh = (east, north, up) =>
        O.opts.swapXY ? rawToMesh(north, east, up) : rawToMesh(east, north, up);

      function liveSplits(Z) {
        const lad = Z.atlas.ladder && Z.atlas.ladder[Z.rung];
        return (lad && lad.splits) || Z.atlas.splits || [];
      }
      // Mirror of app.js bandGroupForY: which storey does this height belong to?
      function bandIndexForY(Z, y) {
        let b = 0; for (const s of liveSplits(Z)) if (y >= s) b++;
        return Math.min(b, Math.max(0, (Z.groups ? Z.groups.length : 1) - 1));
      }
      function bandGroupForY(Z, y) {
        if (!Z || !Z.groups) return D.scene;
        return Z.groups[bandIndexForY(Z, y)] || Z.groups[0] || D.scene;
      }
      // Z.clip is PER BAND: Z.clip[i] = [yMinPlane, yMaxPlane], and applyZClip() slides each pair with
      // that band's explode-lift. Handing a material the whole nested array clips everything away —
      // an overlay object must take the plane pair of the band it was parented into.
      function bandClip(Z, y) {
        return (Z.clip && Z.clip[bandIndexForY(Z, y)]) || [];
      }

      // A hand-rolled tube. three's TubeGeometry parameterises by ARC LENGTH, which would smear a
      // 9-minute camp (hundreds of samples in a 10-unit blob) into a single ring — and the whole point
      // of the animation is that time, not distance, drives it. So we walk our own samples, emit one
      // ring per sample, and carry a per-vertex normalised TIME plus SPEED for the shader.
      function buildTube(P, radius, radial) {
        const n = P.length, ring = radial + 1;                 // +1 = seam duplicate for clean UVs
        const pos = new Float32Array(n * ring * 3);
        const nor = new Float32Array(n * ring * 3);
        const aT  = new Float32Array(n * ring);
        const aS  = new Float32Array(n * ring);
        const idx = new Uint32Array((n - 1) * radial * 6);
        const tan = new T.Vector3(), nrm = new T.Vector3(0, 1, 0), bin = new T.Vector3();
        const prevN = new T.Vector3(0, 1, 0), tmp = new T.Vector3();

        for (let i = 0; i < n; i++) {
          const a = P[Math.max(0, i - 1)].p, b = P[Math.min(n - 1, i + 1)].p;
          tan.subVectors(b, a);
          if (tan.lengthSq() < 1e-9) tan.set(0, 0, 1);
          tan.normalize();
          // Parallel transport: carry the previous normal forward and re-orthogonalise. Frenet frames
          // flip through inflection points and the ribbon visibly twists; this doesn't.
          nrm.copy(prevN).addScaledVector(tan, -prevN.dot(tan));
          if (nrm.lengthSq() < 1e-6) nrm.set(tan.z, 0, -tan.x);   // degenerate: pick any perpendicular
          nrm.normalize(); prevN.copy(nrm);
          bin.crossVectors(tan, nrm);
          for (let j = 0; j <= radial; j++) {
            const th = (j / radial) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
            tmp.copy(nrm).multiplyScalar(c).addScaledVector(bin, s);
            const o = (i * ring + j) * 3;
            pos[o] = P[i].p.x + tmp.x * radius; pos[o + 1] = P[i].p.y + tmp.y * radius; pos[o + 2] = P[i].p.z + tmp.z * radius;
            nor[o] = tmp.x; nor[o + 1] = tmp.y; nor[o + 2] = tmp.z;
            aT[i * ring + j] = P[i].u;
            aS[i * ring + j] = P[i].s;
          }
        }
        let k = 0;
        for (let i = 0; i < n - 1; i++) for (let j = 0; j < radial; j++) {
          const a = i * ring + j, b = a + ring;
          idx[k++] = a; idx[k++] = b; idx[k++] = a + 1;
          idx[k++] = b; idx[k++] = b + 1; idx[k++] = a + 1;
        }
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(pos, 3));
        g.setAttribute('normal', new T.BufferAttribute(nor, 3));
        g.setAttribute('aT', new T.BufferAttribute(aT, 1));
        g.setAttribute('aS', new T.BufferAttribute(aS, 1));
        g.setIndex(new T.BufferAttribute(idx, 1));
        g.computeBoundingSphere();
        return g;
      }

      const RAMP_GLSL = `
        vec3 rampAt(float u, int which){
          vec3 s[8];
          if(which==0){ s[0]=vec3(0.02,0.01,0.08); s[1]=vec3(0.23,0.04,0.33); s[2]=vec3(0.45,0.09,0.42);
                        s[3]=vec3(0.66,0.17,0.36); s[4]=vec3(0.85,0.30,0.23); s[5]=vec3(0.96,0.49,0.10);
                        s[6]=vec3(0.99,0.70,0.15); s[7]=vec3(0.99,0.94,0.64); }
          else        { s[0]=vec3(0.03,0.10,0.22); s[1]=vec3(0.05,0.24,0.42); s[2]=vec3(0.06,0.40,0.58);
                        s[3]=vec3(0.09,0.56,0.68); s[4]=vec3(0.24,0.72,0.75); s[5]=vec3(0.52,0.85,0.82);
                        s[6]=vec3(0.78,0.94,0.92); s[7]=vec3(1.00,1.00,1.00); }
          float f = clamp(u,0.0,1.0)*7.0; int i = int(floor(min(f,6.0))); float k = f-float(i);
          vec3 a=s[0], b=s[1];
          for(int q=0;q<7;q++){ if(q==i){ a=s[q]; b=s[q+1]; } }
          return mix(a,b,k);
        }`;

      function pathMaterial(clip) {
        return new T.ShaderMaterial({
          transparent: true, depthWrite: false, clipping: true, clippingPlanes: clip || [],
          uniforms: {
            uHead: { value: 1 }, uTrail: { value: DEFAULTS.trail }, uFuture: { value: DEFAULTS.future },
            uMode: { value: 0 },            // 0 = colour by time, 1 = by speed
          },
          // THE TWO CHUNKS THAT ARE NOT OPTIONAL HERE
          //  * clipping_planes_*  — the atlas runs renderer.localClippingEnabled and slices each
          //    floor band by the height slider. Skip these and the overlay ignores the slider.
          //  * logdepthbuf_*      — app.js builds its renderer with logarithmicDepthBuffer: true
          //    (zones span 400,000 units near-to-far). EVERY other mesh on the page writes
          //    logarithmic depth; a shader that writes ordinary depth loses the depth test against
          //    the ground and is invisible everywhere, with NO error in the console. That failure
          //    looks exactly like "my geometry is wrong" and is not. Keep these includes.
          // Both chunks read a variable literally named `mvPosition`; renaming it breaks the build.
          vertexShader: `
            attribute float aT; attribute float aS;
            varying float vT; varying float vS; varying vec3 vN;
            #include <common>
            #include <logdepthbuf_pars_vertex>
            #include <clipping_planes_pars_vertex>
            void main(){
              vT = aT; vS = aS; vN = normalize(normalMatrix * normal);
              vec4 mvPosition = modelViewMatrix * vec4(position,1.0);
              #include <clipping_planes_vertex>
              gl_Position = projectionMatrix * mvPosition;
              #include <logdepthbuf_vertex>
            }`,
          fragmentShader: `
            precision highp float;
            varying float vT; varying float vS; varying vec3 vN;
            uniform float uHead, uTrail, uFuture; uniform int uMode;
            #include <common>
            #include <logdepthbuf_pars_fragment>
            #include <clipping_planes_pars_fragment>
            ${RAMP_GLSL}
            void main(){
              #include <clipping_planes_fragment>
              #include <logdepthbuf_fragment>
              float behind = uHead - vT;
              float a;
              if (behind < 0.0) {                       // not walked yet — the faint route ahead
                a = uFuture;
                if (a <= 0.001) discard;
              } else {
                a = mix(0.30, 1.0, exp(-behind / max(uTrail, 1e-4)));   // fresh track burns brighter
              }
              vec3 c = rampAt(uMode==1 ? vS : vT, 1);
              // The head of the comet blows out to white so the eye locks onto "now".
              float hot = smoothstep(uTrail*0.35, 0.0, abs(behind));
              c = mix(c, vec3(1.0), hot*0.85*step(0.0,behind));
              // Cheap rim shading so the tube reads round rather than as a flat noodle.
              c *= 0.72 + 0.28 * abs(vN.y);
              gl_FragColor = vec4(c, a);
            }`,
        });
      }

      // ============================ the overlay =============================
      const O = {
        opts: Object.assign({}, DEFAULTS),
        raw: [],            // parsed loc samples
        tubes: [],          // one per unbroken run of samples; all share O.pathMat
        tube: null, pathMat: null, heat: null, head: null, beam: null,
        t0: 0, t1: 1, u: 1, playing: false, _raf: 0, _last: 0,
        ev: {}, stats: null, graves: [], pos: {}, hidden: { ours: false, site: false }, statsOpen: true,
      };

      function detach() {
        for (const o of [...O.tubes, ...(O.graves || []), O.heat, O.head, O.beam]) {
          if (o && o.parent) o.parent.remove(o);
          if (o && o.geometry) o.geometry.dispose();
        }
        for (const g of O.graves || []) if (g.material) g.material.dispose();
        // The tubes SHARE one material — dispose it once, not once per run.
        if (O.pathMat) O.pathMat.dispose();
        for (const o of [O.heat, O.head, O.beam]) if (o && o.material) o.material.dispose();
        O.tubes = []; O.graves = []; O.runs = 0; O.lone = 0; O.gravesSkipped = 0;
        O.tube = O.pathMat = O.heat = O.head = O.beam = null;
      }

      // Tear down EVERYTHING this script added. Called on close, and — importantly — by the next copy
      // of the script at the top of the file. A userscript and the extension can both be installed, an
      // old install can linger beside a new one, and the console path can be pasted twice; whatever the
      // route, the newest copy wipes the previous one so there is only ever one panel, one key handler
      // and one animation loop. Miss anything here and you get two stacked panels where only the
      // buried one responds — which is precisely how this was found.
      O.clear = function () {
        O.playing = false; cancelAnimationFrame(O._raf);
        clearTimeout(O._peekT); clearTimeout(saveTimer);
        detach(); O.raw = []; O.ev = {}; O.stats = null;
        removeEventListener('keydown', onKey);
        removeEventListener('pointermove', flashPeek);
        for (const id of ['eqtrail-panel', 'eqtrail-stats', 'eqtrail-peek']) {
          const e = document.getElementById(id); if (e) e.remove();
        }
        document.querySelectorAll('style[data-eqtrail]').forEach(e => e.remove());
        document.documentElement.classList.remove('eqt-hide-ours', 'eqt-hide-site');
        window.EQTrail = null;
      };

      function zoneKeyForName(name) {
        const M = D.MANIFEST || [];
        const n = name.toLowerCase();
        const hit = M.find(z => z.name.toLowerCase() === n) ||
                    M.find(z => z.name.toLowerCase().includes(n) || n.includes(z.name.toLowerCase()));
        return hit && hit.key;
      }

      O.loadLog = function (text) { return accept(parseLog(text)); };

      // The drop/browse path. Streams the file and reports progress, because "nothing is happening"
      // for twenty seconds on a 121 MB log is indistinguishable from "it's broken".
      O.loadFile = async function (file) {
        const mb = (file.size / 1048576).toFixed(0);
        note(`Reading ${file.name} (${mb} MB)… 0%`);
        const t0 = performance.now();
        const parsed = await parseFile(file, f => note(`Reading ${file.name} (${mb} MB)… ${Math.round(f * 100)}%`));
        console.log(`[EQTrail] parsed ${file.name} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
        return accept(parsed);
      };

      function accept({ pts, zones, ev }) {
        O.ev = ev || {};
        if (!pts.length) {
          note('No "Your Location is" lines in that file — is the /loc macro actually firing, and is ' +
               'this the right eqlog_*.txt?');
          return { pts: 0, zones: zones.length };
        }
        O.segments = groupZones(segmentize(pts, zones));
        O.totalPts = pts.length;
        // Default to the zone ALREADY on the page if the log has any samples there — the reader chose
        // that zone, and silently yanking them to a different one is rude. Otherwise take the zone with
        // the most samples, preferring one the atlas can actually draw.
        const here = D.Z && O.segments.find(s => s.key === D.Z.key);
        const best = here || O.segments.find(s => s.key) || O.segments[0];
        fillSegPicker();
        O.useSegment(O.segments.indexOf(best));
        return { pts: pts.length, zones: O.segments.length, zone: best.name, showing: best.pts.length };
      }

      // Switching segments may mean switching ZONES. loadZone() tears the scene down and rebuilds the
      // band groups, which takes our objects with it, so the rebuild has to wait for it to resolve.
      O.useSegment = async function (i) {
        const s = O.segments && O.segments[i];
        if (!s) return;
        O.segIdx = i;
        O.raw = s.pts;
        const sel = document.getElementById('eqtrail-seg');
        if (sel) sel.value = String(i);
        let failed = false;
        if (s.key && D.Z && s.key !== D.Z.key) {
          note(`Loading ${s.name}…`);
          try { await D.loadZone(s.key); note(''); }
          catch (e) { failed = true; note('Could not load ' + s.name + ' — drawing on the zone you have open.'); }
        } else if (!s.key) {
          note(s.name ? `No atlas zone matches "${s.name}" — drawing on the zone you have open.`
                      : 'Log has no zone line before these /locs — drawing on the zone you have open.');
        } else { note(''); }
        buildStats();
        O.rebuild();
        O.setT(0); O.play();
      };

      O.loadPoints = function (pts) {
        const arr = pts.slice().sort((a, b) => a.t - b.t);
        spreadWithinSecond(arr);
        O.segments = [{ name: null, key: null, pts: arr, t0: arr[0].t, t1: arr[arr.length - 1].t }];
        fillSegPicker();
        O.useSegment(0);
      };

      O.rebuild = function () {
        const Z = D.Z;
        if (!Z) { console.warn('[EQTrail] no zone loaded'); return; }
        if (!O.raw.length) return;
        detach();

        const o = O.opts;
        const scaleR = Math.max(0.35, Z.span * 0.0006);        // one look across zones of very different size
        const R = o.tubeRadius * scaleR;

        // ---- samples -> mesh space, with per-sample dwell + speed ----
        const S = O.raw.map(r => ({ t: r.t, p: locToMesh(r.east, r.north, r.up) }));
        O.t0 = S[0].t; O.t1 = S[S.length - 1].t;
        const span = Math.max(1e-6, O.t1 - O.t0);
        // Dwell credit per sample. Each INTERVAL between samples is passed through the gap policy
        // first, then split half to the sample on either side — so a long silence is discounted once,
        // at the interval that actually contains it, rather than twice at both of its endpoints.
        const eff = [];
        for (let i = 0; i < S.length - 1; i++) eff.push(heatGap(S[i + 1].t - S[i].t));
        const dts = [];
        for (let i = 0; i < S.length; i++) {
          const a = i > 0 ? eff[i - 1] : 0, b = i < eff.length ? eff[i] : 0;
          dts.push((a + b) / 2 || 1);
        }
        let maxSpd = 1e-6;
        for (let i = 1; i < S.length; i++) {
          const d = S[i].p.distanceTo(S[i - 1].p) / Math.max(0.5, S[i].t - S[i - 1].t);
          S[i].spd = d; maxSpd = Math.max(maxSpd, d);
        }
        if (S.length) S[0].spd = S[1] ? S[1].spd : 0;

        // ---- 1. the path ----
        if (o.pathOn) {
          const P = S.map((s, i) => ({
            p: new T.Vector3(s.p.x, s.p.y + o.yLift * scaleR, s.p.z),
            u: (s.t - O.t0) / span,
            s: Math.min(1, s.spd / (maxSpd * 0.85)),
          }));
          // Cut the point list wherever the log went quiet. Each run becomes its own tube; they all
          // share ONE material, so the playback uniforms still drive every piece together.
          const runs = [];
          let run = [P[0]];
          for (let i = 1; i < P.length; i++) {
            if (S[i].t - S[i - 1].t > o.gapBreak) { runs.push(run); run = []; }
            run.push(P[i]);
          }
          runs.push(run);

          const midY = P[Math.floor(P.length / 2)].p.y;
          const mat = pathMaterial(bandClip(Z, midY));
          mat.uniforms.uTrail.value = o.trail;
          mat.uniforms.uFuture.value = o.future;
          mat.uniforms.uMode.value = o.colorBy === 'speed' ? 1 : 0;
          O.pathMat = mat;
          for (const r of runs) {
            if (r.length < 2) continue;              // a lone sample has no direction — nothing to extrude
            const mesh = new T.Mesh(buildTube(r, R, o.radialSegments), mat);
            mesh.renderOrder = 995; mesh.frustumCulled = false;
            mesh.raycast = () => {};
            bandGroupForY(Z, midY).add(mesh);
            O.tubes.push(mesh);
          }
          O.tube = O.tubes[0] || null;
          // Report what was actually DRAWN, not how many runs the split produced: a run of one sample
          // has no direction to extrude, so it contributes heat but no ribbon.
          O.runs = O.tubes.length;
          O.lone = runs.length - O.tubes.length;

          // head marker + a dashed column so you can find "now" even when it's behind a hill
          const hg = new T.SphereGeometry(1, 20, 14);
          O.head = new T.Mesh(hg, new T.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.95 }));
          O.head.renderOrder = 999; O.head.scale.setScalar(R * 2.4); O.head.raycast = () => {};
          const bg = new T.BufferGeometry();
          bg.setAttribute('position', new T.BufferAttribute(new Float32Array(6), 3));
          O.beam = new T.Line(bg, new T.LineDashedMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.55, depthTest: false, dashSize: 2.2, gapSize: 1.6 }));
          O.beam.renderOrder = 996; O.beam.raycast = () => {};
          bandGroupForY(Z, P[0].p.y).add(O.head);
          bandGroupForY(Z, P[0].p.y).add(O.beam);
        }

        // ---- 2. the dwell heatmap ----
        if (o.heatOn) buildHeat(Z, S, dts, scaleR); else O.heatStats = null;
        buildGraves(Z, scaleR);
        // Remember where we are in LOG time, rebuild the map, then land on the same moment again.
        // Without this, changing the gap mode keeps the same presentation fraction and therefore jumps
        // the playhead to a different point in the session — which reads as the setting breaking things.
        const wasAt = (O.tmap && O.raw.length) ? logAtPres(O.u * O.presSpan) : null;
        buildTimeMap();
        if (wasAt != null && O.tmap) O.u = Math.min(1, Math.max(0, presAtLog(wasAt) / O.presSpan));

        applyU();
        stat();
      };

      // Bin dwell SECONDS into a grid, blur it, and draw one instanced box per live cell. The box sits
      // at the median sample height of its own cell, so on a multi-storey zone the heat lands on the
      // storey you actually walked — no raycasting needed, the log already told us the elevation.
      // relief = 0 gives a flat plate lying on the floor; relief > 0 extrudes it into a 3D bar-relief.
      function buildHeat(Z, S, dts, scaleR) {
        const o = O.opts, cell = Math.max(1, o.cell * scaleR);
        const bins = new Map();
        for (let i = 0; i < S.length; i++) {
          const ix = Math.floor(S[i].p.x / cell), iz = Math.floor(S[i].p.z / cell);
          const k = ix + ',' + iz;
          let b = bins.get(k);
          if (!b) bins.set(k, b = { ix, iz, w: 0, ys: [] });
          b.w += (o.heatBy === 'visits' ? 1 : dts[i]); b.ys.push(S[i].p.y);
        }
        // Gaussian-ish smoothing across the 8-neighbourhood, so a walked corridor reads as a field
        // rather than as a dotted line of hit cells.
        for (let pass = 0; pass < o.blur; pass++) {
          const next = new Map();
          for (const b of bins.values()) {
            for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
              const k = (b.ix + dx) + ',' + (b.iz + dz);
              const wt = (dx === 0 && dz === 0) ? 0.42 : (dx === 0 || dz === 0) ? 0.105 : 0.0475;
              let n = next.get(k);
              if (!n) next.set(k, n = { ix: b.ix + dx, iz: b.iz + dz, w: 0, ys: [] });
              n.w += b.w * wt;
              if (dx === 0 && dz === 0) n.ys = b.ys;
              else if (!n.ys.length) n.ys = b.ys;
            }
          }
          bins.clear(); for (const [k, v] of next) bins.set(k, v);
        }
        const cells = [...bins.values()];
        let peak = 0; for (const c of cells) peak = Math.max(peak, c.w);
        const live = cells.filter(c => c.w >= peak * o.heatFloor);
        if (!live.length) return;

        const anyY = live[0].ys[0] || 0;
        const geo = new T.BoxGeometry(1, 1, 1);
        // NO vertexColors here. setColorAt() populates mesh.instanceColor, and three defines
        // USE_INSTANCING_COLOR on its own. Setting vertexColors:true ALSO defines USE_COLOR, which
        // makes the shader read a per-vertex `color` attribute a BoxGeometry does not have — it binds
        // to (0,0,0) and multiplies every cell to pure black. (That is the black-tiles bug.)
        const mat = new T.MeshBasicMaterial({
          transparent: true, opacity: o.heatOpacity, depthWrite: false,
          clippingPlanes: bandClip(Z, anyY), toneMapped: false,
        });
        const mesh = new T.InstancedMesh(geo, mat, live.length);
        mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
        const m4 = new T.Matrix4(), col = new T.Color();
        const maxH = o.relief * scaleR * 10;
        live.forEach((c, i) => {
          const u = c.w / peak;
          c.ys.sort((a, b) => a - b);
          const y = c.ys.length ? c.ys[c.ys.length >> 1] : 0;
          const h = o.relief > 0 ? Math.max(0.6, Math.pow(u, 0.7) * maxH) : 0.5 * scaleR;
          m4.makeScale(cell * 0.98, h, cell * 0.98);
          // Sit the plate a little ABOVE the sampled height. The log records the player's feet, the
          // terrain under them is coarse, and a plate flush with y disappears into the ground on any
          // slope — the "heatmap builds but I can't see it" case.
          m4.setPosition((c.ix + 0.5) * cell, y + h / 2 + 0.9 * scaleR, (c.iz + 0.5) * cell);
          mesh.setMatrixAt(i, m4);
          // Gamma-ish lift so mid-range dwell is visible rather than all-black-except-the-camp, and
          // start 18% up the ramp — inferno's bottom end is near-black, which over a dark zone floor
          // reads as a hole punched in the map rather than as "barely visited".
          const rgb = ramp('inferno', 0.18 + 0.82 * Math.pow(u, 0.55));
          // setRGB defaults to the LINEAR working space; these ramp stops are sRGB literals. Skip the
          // conversion and every cell comes out roughly half as bright (the "why is my heatmap black"
          // bug). Same reason the material is toneMapped:false.
          col.setRGB(rgb[0], rgb[1], rgb[2], T.SRGBColorSpace);
          mesh.setColorAt(i, col);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.renderOrder = 990; mesh.frustumCulled = false; mesh.raycast = () => {};
        const midY = live[Math.floor(live.length / 2)].ys[0] || 0;
        bandGroupForY(Z, midY).add(mesh);
        O.heat = mesh;
        O.heatStats = { cells: live.length, peak, by: o.heatBy, cell };
      }

      // ============================ playback ================================
      // Index of the last /loc sample at or before t (binary search — the scrubber can jump).
      function sampleIndexAt(t) {
        let lo = 0, hi = O.raw.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (O.raw[mid].t <= t) lo = mid; else hi = mid - 1; }
        return lo;
      }

      // Where were you at time t? Interpolates between the surrounding samples when they are close
      // together. When they are NOT — the macro stopped, or you died and stood still — interpolating
      // across the gap would invent a position halfway to wherever you went next, so we stay put on the
      // last known sample instead. `null` when the nearest sample is further off than gapBreak: better
      // to place no marker than a confident one in the wrong place.
      function posAt(t, tolerate) {
        if (!O.raw.length) return null;
        const i = sampleIndexAt(t);
        const a = O.raw[i], b = O.raw[Math.min(O.raw.length - 1, i + 1)];
        if (tolerate != null && Math.abs(t - a.t) > tolerate && Math.abs(b.t - t) > tolerate) return null;
        const gap = b.t - a.t;
        const k = (gap > 0 && gap <= 30) ? (t - a.t) / gap : 0;
        return locToMesh(a.east + (b.east - a.east) * k,
                         a.north + (b.north - a.north) * k,
                         a.up + (b.up - a.up) * k);
      }

      function applyU() {
        if (!O.raw.length) { if (O.pathMat) O.pathMat.uniforms.uHead.value = O.u; return; }
        // O.u is a position on the PRESENTATION clock. Everything else — the shader, the graves, the
        // stats — speaks log time, so convert once here and let them stay honest.
        const tNow = O.tmap ? logAtPres(O.u * O.presSpan) : O.t0 + (O.t1 - O.t0) * O.u;
        if (O.pathMat) O.pathMat.uniforms.uHead.value = (tNow - O.t0) / Math.max(1e-6, O.t1 - O.t0);
        const a = O.raw[sampleIndexAt(tNow)];
        const p = posAt(tNow);
        updateGraves(tNow);
        if (O.head) { O.head.position.copy(p); O.head.position.y += O.opts.yLift; O.head.visible = O.opts.pathOn; }
        if (O.beam && D.Z) {
          const bb = D.Z.atlas.bounds, pa = O.beam.geometry.attributes.position;
          pa.setXYZ(0, p.x, bb.min[1] - 5, p.z); pa.setXYZ(1, p.x, bb.max[1] + 5, p.z);
          pa.needsUpdate = true; O.beam.computeLineDistances(); O.beam.visible = O.opts.pathOn;
        }
        const hud = document.getElementById('eqtrail-hud');
        if (hud) {
          const d = new Date(tNow * 1000);
          const g = gapAt(tNow);
          hud.textContent = `${d.toISOString().slice(11, 19)}  ·  ${a.north.toFixed(0)}, ${a.east.toFixed(0)}, ${a.up.toFixed(0)}`
            + (g ? `   ${O.opts.gapMode === 'ff' ? '\u23e9' : '\u23ed'} ${fmtDur(g)} gap` : '');
        }
        const sc = document.getElementById('eqtrail-scrub');
        if (sc && document.activeElement !== sc) sc.value = String(Math.round(O.u * 1000));
        if (O.statsOpen && O._updateStats) O._updateStats(tNow);
      }

      O.setT = function (u) { O.u = Math.min(1, Math.max(0, u)); applyU(); };
      O.pause = function () { O.playing = false; cancelAnimationFrame(O._raf); syncBtn(); };
      O.play = function () {
        if (O.playing) return;
        O.playing = true; O._last = performance.now(); syncBtn();
        const tick = (now) => {
          if (!O.playing) return;
          const dt = (now - O._last) / 1000; O._last = now;
          // Advance on the presentation clock: with gaps skipped this span is shorter than the session,
          // so the same `speed` setting spends its time on the parts worth watching.
          const span = O.tmap ? O.presSpan : Math.max(1, O.t1 - O.t0);
          O.u += (O.opts.speed * dt) / span;
          if (O.u >= 1) { O.u = 0; }            // loop
          applyU();
          O._raf = requestAnimationFrame(tick);
        };
        O._raf = requestAnimationFrame(tick);
      };
      function syncBtn() { const b = document.getElementById('eqtrail-play'); if (b) b.textContent = O.playing ? '⏸' : '▶'; }

      // ======================== gap policy / time warp ======================
      // Playback runs on a PRESENTATION clock, not the log clock. The two are related by a piecewise
      // linear map built once per rebuild: ordinary intervals map 1:1, gaps map through the policy. So
      // "skip" is not a special case sprinkled through the animation loop — it is just a segment of the
      // map with zero length, and everything downstream keeps working in honest log time.
      const gapAffects = layer => O.opts.gapApply === 'both' || O.opts.gapApply === layer;

      // Presentation duration of one interval between samples.
      function animGap(dt) {
        const o = O.opts;
        if (!gapAffects('anim') || dt <= o.gapThreshold || o.gapMode === 'real') return dt;
        if (o.gapMode === 'ff') return o.gapThreshold + (dt - o.gapThreshold) / Math.max(1, o.gapFF);
        return 0;                                   // skip — jump it, there is nothing to watch
      }
      // Dwell credit for one interval between samples.
      function heatGap(dt) {
        const o = O.opts;
        if (!gapAffects('heat') || dt <= o.gapThreshold || o.gapMode === 'real') return dt;
        if (o.gapMode === 'ff') return o.gapThreshold + (dt - o.gapThreshold) / Math.max(1, o.gapFF);
        return o.gapThreshold;                      // skip — cap it, do not erase the camp
      }

      // Build the map. `log[i]` is the sample's real timestamp, `pres[i]` where it lands on the
      // presentation clock. Both are monotonic, so either direction is a binary search plus a lerp.
      function buildTimeMap() {
        O.tmap = null; O.gapStats = null;
        if (!O.raw || O.raw.length < 2) return;
        const log = [O.raw[0].t], pres = [0];
        let skipped = 0, gaps = 0;
        for (let i = 1; i < O.raw.length; i++) {
          const dt = O.raw[i].t - O.raw[i - 1].t;
          const shown = animGap(dt);
          if (dt > O.opts.gapThreshold) { gaps++; skipped += dt - shown; }
          log.push(O.raw[i].t);
          pres.push(pres[pres.length - 1] + shown);
        }
        O.tmap = { log, pres };
        O.presSpan = Math.max(1e-6, pres[pres.length - 1]);
        O.gapStats = { gaps, skipped, logSpan: Math.max(1e-6, O.raw[O.raw.length - 1].t - O.raw[0].t) };
      }

      function lerpMap(from, to, v) {
        if (!O.tmap) return v;
        const a = O.tmap[from], b = O.tmap[to];
        if (v <= a[0]) return b[0];
        if (v >= a[a.length - 1]) return b[b.length - 1];
        let lo = 0, hi = a.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (a[mid] <= v) lo = mid; else hi = mid - 1; }
        const hiI = Math.min(a.length - 1, lo + 1);
        const d = a[hiI] - a[lo];
        // A zero-length segment is a skipped gap: land on its far end rather than dividing by zero.
        return d > 0 ? b[lo] + (b[hiI] - b[lo]) * ((v - a[lo]) / d) : b[hiI];
      }
      const logAtPres = p => lerpMap('pres', 'log', p);
      const presAtLog = t => lerpMap('log', 'pres', t);

      // Is the playhead inside a compressed gap right now? Used to tell the reader what just happened,
      // so a sudden jump reads as a deliberate skip rather than as a glitch.
      function gapAt(t) {
        if (!O.tmap || O.opts.gapMode === 'real' || !gapAffects('anim')) return null;
        const L = O.tmap.log;
        let lo = 0, hi = L.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (L[mid] <= t) lo = mid; else hi = mid - 1; }
        const hiI = Math.min(L.length - 1, lo + 1);
        const dt = L[hiI] - L[lo];
        return dt > O.opts.gapThreshold ? dt : null;
      }

      // ======================= version & issue reporting ====================
      // Development here is hands-off: a friend runs it, something looks wrong, and there is no
      // practical path from "that's odd" to a filed issue. These three things close that loop without
      // a backend of any kind — GitHub Pages serves a static manifest with `access-control-allow-origin: *`,
      // and GitHub's own new-issue form accepts a prefilled title and body over the URL.
      const BUILD = window.__EQTRAIL_BUILD || { version: 'dev', flavour: 'console', pinned: false };
      const REPO = 'https://github.com/kevroy314/eqatlas-overlay';
      const PAGES = 'https://kevroy314.github.io/eqatlas-overlay';
      const VCHECK_KEY = 'eqtrail.vcheck.v1';
      const DAY = 86400000;

      const vparts = v => String(v || '0').split('.').map(n => parseInt(n, 10) || 0);
      function newerThan(a, b) {                       // is a > b?
        const A = vparts(a), B = vparts(b);
        for (let i = 0; i < 3; i++) {
          if ((A[i] || 0) > (B[i] || 0)) return true;
          if ((A[i] || 0) < (B[i] || 0)) return false;
        }
        return false;
      }

      // Cached for a day so a browsing session costs at most one request, and failure is silent:
      // offline, a page CSP, a rate limit or a typo in the manifest must never break the overlay.
      async function checkVersion(force) {
        if (!O.opts.updateCheck) { O.release = null; syncAbout(); return; }
        let c = {};
        try { c = JSON.parse(localStorage.getItem(VCHECK_KEY) || '{}'); } catch (e) {}
        if (!force && c.at && Date.now() - c.at < DAY && c.data) { O.release = c.data; syncAbout(); return; }
        try {
          const r = await fetch(PAGES + '/versions.json', { cache: 'no-cache' });
          if (!r.ok) throw new Error(r.status);
          const d = await r.json();
          try { localStorage.setItem(VCHECK_KEY, JSON.stringify({ at: Date.now(), data: d })); } catch (e) {}
          O.release = d;
        } catch (e) {
          console.log('[EQTrail] version check skipped:', e.message);
          O.release = c.data || null;                  // fall back to whatever we last saw
        }
        syncAbout();
      }
      O.checkVersion = checkVersion;

      // What goes in a bug report. Deliberately NOTHING from the log itself — no file name (which
      // carries the character name), no coordinates, no timestamps. Counts and settings only. The
      // reader still sees the whole body in GitHub's form before submitting, which is the real consent
      // gate; this just makes sure there is nothing there they would want to remove.
      function gpuInfo() {
        try {
          const c = document.createElement('canvas');
          const gl = c.getContext('webgl2') || c.getContext('webgl');
          if (!gl) return 'no webgl';
          const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
          const lose = gl.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();                // GL contexts are a limited resource — give it back
          return String(name).slice(0, 90);
        } catch (e) { return '?'; }
      }

      function diagnostics() {
        const Z = D.Z, h = O.heatStats, g = O.gapStats;
        const o = O.opts;
        const lines = [
          '', '', '---', '<details><summary>Diagnostics</summary>', '', '```',
          `EQ Trail   ${BUILD.version}${BUILD.pinned ? ' (pinned)' : ''} · ${BUILD.flavour}`,
          `page       ${location.host}${location.pathname}`,
          `zone       ${Z ? Z.key : '(none loaded)'}   three r${T.REVISION}`,
          `browser    ${navigator.userAgent}`,
          `gpu        ${gpuInfo()}`,
        ];
        if (O.raw && O.raw.length) {
          lines.push(
            `log        ${O.raw.length} locs here, ${O.totalPts || O.raw.length} total, ` +
            `${O.segments ? O.segments.length : 1} zones`,
            `drawn      ${O.runs || 0} runs, ${O.graves ? O.graves.length : 0} graves` +
            (h ? `, ${h.cells} cells` : ''),
            `gaps       ${g ? g.gaps : 0} over ${o.gapThreshold}s` +
            (g && g.skipped ? `, ${Math.round(g.skipped)}s removed` : ''));
        } else {
          lines.push('log        (none loaded)');
        }
        lines.push(`settings   ${JSON.stringify(o)}`, '```', '', '</details>');
        return lines.join('\n');
      }

      // GitHub caps how much it will take on the URL; a runaway user-agent or settings blob must not
      // silently produce a dead link. Trim the diagnostics rather than the person's own words.
      function issueUrl(kind) {
        const bug = kind === 'bug';
        const title = bug ? '' : '';
        const intro = bug
          ? ['**What happened?**', '', '', '**What did you expect?**', '', '',
             '**Which log / zone?** (please do not paste log contents — a description is enough)', '', '']
          : ['**What would you like it to do?**', '', '', '**Why — what are you trying to find out?**', '', ''];
        let body = intro.join('\n') + diagnostics();
        const base = `${REPO}/issues/new?labels=${bug ? 'bug' : 'enhancement'}` +
                     `&title=${encodeURIComponent(title)}&body=`;
        while (encodeURIComponent(body).length + base.length > 6000 && body.length > 400) {
          body = body.slice(0, body.length - 200);
        }
        return base + encodeURIComponent(body);
      }
      O.issueUrl = issueUrl;

      // The about row. Three states: up to date, an update waiting, or the check turned off.
      function syncAbout() {
        const v = document.getElementById('eqtrail-ver');
        if (!v) return;
        const rel = O.release, cur = BUILD.version;
        const bits = [`v${cur}`];
        if (BUILD.pinned) bits.push('pinned');
        if (!O.opts.updateCheck) bits.push('checks off');
        else if (rel && newerThan(rel.latest, cur)) {
          v.innerHTML = `v${cur}${BUILD.pinned ? ' pinned' : ''} · ` +
            `<a href="${PAGES}/${rel.install}" target="_blank" rel="noopener">update to ${rel.latest} \u2192</a>`;
          return;
        } else if (rel) bits.push('up to date');
        v.textContent = bits.join(' \u00b7 ');
      }
      O._syncAbout = syncAbout;

      // Rolling back is the point here: a bad release should be one click to escape, not a git
      // expedition. Each entry is a PINNED build with no @updateURL, so it stays put once installed.
      function renderVersions() {
        const box = document.getElementById('eqtrail-verlist');
        if (!box) return;
        const rel = O.release;
        if (!rel || !rel.versions || !rel.versions.length) {
          box.innerHTML = `<div class="eqt-vhint">No version list yet — it is fetched once a day from the
            project page.${O.opts.updateCheck ? '' : ' Update checks are currently <b>off</b>.'}
            <a href="${REPO}/releases" target="_blank" rel="noopener">All releases \u2192</a></div>`;
          return;
        }
        const rows = rel.versions.slice(0, 8).map(e => {
          const cur = e.v === BUILD.version;
          return `<a href="${PAGES}/${e.pinned}" target="_blank" rel="noopener"${cur ? ' class="cur"' : ''}>` +
                 `<span>v${e.v}${cur ? ' \u2190 installed' : ''}</span><i>${e.date}</i></a>`;
        }).join('');
        box.innerHTML = rows +
          `<div class="eqt-vhint"><b>Pinned</b> — these do not auto-update, so a rollback sticks. Older ones
           have no version row: return via <a href="${PAGES}/${rel.install}" target="_blank"
           rel="noopener">the install page</a> · <a href="${REPO}/releases" target="_blank"
           rel="noopener">notes</a></div>`;
      }

      // ============================ gravestones =============================
      // One marker per death, placed where the /loc track says you were standing, revealed in step with
      // playback so a death shows up as the trail reaches it.
      //
      // Drawn as a Sprite from a canvas texture rather than as geometry: a sprite always faces the
      // camera, so the icon stays legible from any orbit angle, and SpriteMaterial is one of three's own
      // materials — which means it already carries the logarithmic-depth chunks this renderer requires.
      // A hand-written shader here would silently vanish behind the terrain, the same trap the trail hit.
      let graveTex = null;
      function graveTexture() {
        if (graveTex) return graveTex;
        const S = 64, c = document.createElement('canvas');
        c.width = c.height = S;
        const g = c.getContext('2d');
        // A rounded-top headstone with a cross, drawn once. Pale stone with a dark outline so it reads
        // against both grass and the near-black sky, plus a soft shadow so it does not look pasted on.
        g.clearRect(0, 0, S, S);
        g.translate(S / 2, S / 2);
        const w = 22, h = 26, r = 11;
        g.beginPath();
        g.moveTo(-w / 2, h / 2);
        g.lineTo(-w / 2, -h / 2 + r);
        g.arc(0, -h / 2 + r, r, Math.PI, 0);
        g.lineTo(w / 2, h / 2);
        g.closePath();
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.save(); g.translate(1.5, 2); g.fill(); g.restore();   // shadow
        g.fillStyle = '#d8d4e4'; g.fill();
        g.lineWidth = 2.5; g.strokeStyle = '#2a2438'; g.stroke();
        g.strokeStyle = '#4a4360'; g.lineWidth = 3;              // the cross
        g.beginPath();
        g.moveTo(0, -13); g.lineTo(0, 4);
        g.moveTo(-6, -6); g.lineTo(6, -6);
        g.stroke();
        graveTex = new T.CanvasTexture(c);
        graveTex.colorSpace = T.SRGBColorSpace;                  // canvas pixels are sRGB, not linear
        return graveTex;
      }

      function buildGraves(Z, scaleR) {
        O.graves = [];
        const ev = O.ev && O.ev.deaths;
        if (!ev || !ev.t.length || !O.opts.gravesOn) return;
        const t0 = O.raw[0].t, t1 = O.raw[O.raw.length - 1].t;
        let skipped = 0;
        for (let i = 0; i < ev.t.length; i++) {
          const t = ev.t[i];
          if (t < t0 || t > t1) continue;                        // a death in another zone's visit
          const p = posAt(t, O.opts.gapBreak);
          if (!p) { skipped++; continue; }                       // no nearby /loc — placement unknowable
          const mat = new T.SpriteMaterial({
            map: graveTexture(), transparent: true, depthWrite: false,
            clippingPlanes: bandClip(Z, p.y), sizeAttenuation: true, toneMapped: false,
          });
          const sp = new T.Sprite(mat);
          const r = Math.max(1.6, Z.span * 0.011);               // one apparent size across zone scales
          sp.scale.set(r, r, 1);
          sp.position.set(p.x, p.y + r * 0.55 + O.opts.yLift * scaleR, p.z);   // stand it ON the ground
          sp.renderOrder = 997;
          sp.visible = false;
          sp.userData.t = t;
          bandGroupForY(Z, p.y).add(sp);
          O.graves.push(sp);
        }
        O.gravesSkipped = skipped;
      }

      // Reveal each stone as the playhead passes its moment. Cheap enough to just re-assert every frame.
      function updateGraves(tNow) {
        if (!O.graves) return;
        const on = O.opts.gravesOn;
        for (const sp of O.graves) sp.visible = on && sp.userData.t <= tNow;
      }

      // ======================= stats: scope + curves ========================
      // The cards and the chart show the SAME window the map is showing: the active zone segment's
      // time range. Anything else and the playhead would be scrubbing one timeline while the numbers
      // counted a different one.
      //
      // Each metric becomes a pair of parallel arrays — sample times and a running total — so the
      // value at any playback moment is one binary search, cheap enough to run every frame.
      function buildStats() {
        O.stats = null;
        if (!O.raw || !O.raw.length) return;
        const t0 = O.raw[0].t, t1 = O.raw[O.raw.length - 1].t;
        const S = {};
        // The raw counters behind the ratios are built like any other series, then divided.
        for (const m of METRICS.map(x => x.k).concat(['hitOut', 'missOut', 'hitIn', 'missIn'])
                               .filter(k => k !== 'dist' && k !== 'acc' && k !== 'eva')
                               .map(k => ({ k }))) {
          const a = O.ev && O.ev[m.k];
          if (!a || !a.t.length) continue;
          const ts = [], cum = [];
          let run = 0;
          for (let i = 0; i < a.t.length; i++) {
            const t = a.t[i];
            if (t < t0) continue;
            if (t > t1) break;                 // log order is chronological, so we're past the window
            run += a.v[i];
            ts.push(t); cum.push(run);
          }
          if (ts.length) S[m.k] = { t: ts, cum, total: run };
        }
        // Distance is derived from the track rather than the text — and it respects the same gap break
        // the ribbon uses, so a five-day pause is not silently counted as a sprint across the zone.
        {
          const ts = [], cum = [];
          let run = 0;
          for (let i = 1; i < O.raw.length; i++) {
            const a = O.raw[i - 1], b = O.raw[i];
            if (b.t - a.t <= O.opts.gapBreak) {
              const dx = b.east - a.east, dy = b.north - a.north, dz = b.up - a.up;
              run += Math.sqrt(dx * dx + dy * dy + dz * dz);
            }
            ts.push(b.t); cum.push(run);
          }
          if (ts.length) S.dist = { t: ts, cum, total: run };
        }
        O.stats = { S, t0, t1 };
        renderCards();
      }

      // Running total at time t — the last sample at or before it.
      function valueAt(series, t) {
        if (!series || !series.t.length || t < series.t[0]) return 0;
        let lo = 0, hi = series.t.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (series.t[mid] <= t) lo = mid; else hi = mid - 1; }
        return series.cum[lo];
      }

      // A ratio is "of everything so far", to match every other number on the panel being a running
      // total. It settles as the session goes on rather than twitching per fight — which is the honest
      // reading of "how often did I connect", and the only one that is stable with sparse data.
      function ratioAt(m, t) {
        const S = O.stats && O.stats.S;
        if (!S) return null;
        const a = S[m.ratio[0]], b = S[m.ratio[1]];
        if (!a && !b) return null;
        const x = a ? valueAt(a, t) : 0, y = b ? valueAt(b, t) : 0;
        return (x + y) > 0 ? x / (x + y) : null;
      }
      const hasRatio = m => !!(m.ratio && O.stats && (O.stats.S[m.ratio[0]] || O.stats.S[m.ratio[1]]));

      function fmtVal(kind, v) {
        if (kind === 'ratio') return v == null ? '—' : Math.round(v * 100) + '%';
        if (kind === 'coin') {                       // copper is the storage unit; platinum is the read
          if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'p';
          if (v >= 100) return (v / 100).toFixed(1) + 'g';
          if (v >= 10) return (v / 10).toFixed(1) + 's';
          return Math.round(v) + 'c';
        }
        if (kind === 'pct') return v >= 100 ? (v / 100).toFixed(1) + ' lvl' : v.toFixed(1) + '%';
        if (kind === 'dist') return v >= 10000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v).toString();
        if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
        if (v >= 10000) return (v / 1000).toFixed(1) + 'k';
        return Math.round(v).toLocaleString();
      }

      // ============================ the chart ===============================
      // Hand-rolled SVG rather than a charting library: the extension build is Manifest V3, which
      // forbids remote code, and a bundled d3 would be an order of magnitude more bytes than the whole
      // overlay for one line chart. This does what is actually needed — cumulative curves revealed in
      // step with playback — in about a hundred lines.
      const CHART = { w: 300, h: 116, padL: 6, padR: 6, padT: 8, padB: 16 };

      function seriesColor(k) {                      // colour follows the METRIC, never the pick order
        return SERIES_HEX[METRICS.findIndex(m => m.k === k) % SERIES_HEX.length];
      }

      function drawChart(tNow) {
        const svg = document.getElementById('eqtrail-chart');
        if (!svg || !O.stats) return;
        const M = k => METRICS.find(m => m.k === k);
        const picked = O.opts.series.filter(k => !M(k).ratio && O.stats.S[k]);
        drawBand(tNow);
        const { t0, t1 } = O.stats, span = Math.max(1, t1 - t0);
        const X = t => CHART.padL + (CHART.w - CHART.padL - CHART.padR) * ((t - t0) / span);
        const innerH = CHART.h - CHART.padT - CHART.padB;

        if (!picked.length) {
          svg.innerHTML = `<text x="${CHART.w / 2}" y="${CHART.h / 2}" fill="#6d6590" font-size="11"
            text-anchor="middle">click a card to plot it</text>`;
          return;
        }
        // ONE axis, always. Series of wildly different magnitude (50,000 damage next to 6 deaths)
        // cannot share an absolute scale, and a second y-axis is never the answer — so with more than
        // one series each is drawn as a share of ITS OWN session total and the axis says so. With a
        // single series the axis is that metric's real units.
        const norm = picked.length > 1;
        const maxOf = k => Math.max(1e-9, O.stats.S[k].total);
        const parts = [];

        // grid + axis labels
        const yTicks = norm ? [0, 0.5, 1] : [0, 0.5, 1];
        for (const g of yTicks) {
          const y = CHART.padT + innerH * (1 - g);
          parts.push(`<line x1="${CHART.padL}" y1="${y}" x2="${CHART.w - CHART.padR}" y2="${y}" stroke="#2c2545" stroke-width="1"/>`);
          const lbl = norm ? Math.round(g * 100) + '%' : fmtVal(METRICS.find(m => m.k === picked[0]).fmt, g * maxOf(picked[0]));
          if (g > 0) parts.push(`<text x="${CHART.padL + 2}" y="${y - 2}" fill="#6d6590" font-size="9">${lbl}</text>`);
        }

        for (const k of picked) {
          const s = O.stats.S[k], mx = maxOf(k), col = seriesColor(k);
          const Y = v => CHART.padT + innerH * (1 - (norm ? v / mx : v / mx));
          // Sample the running total on a fixed pixel grid — the underlying series can be half a
          // million events long and none of that detail survives 300 pixels anyway.
          const N = 160;
          let d = '', dFuture = '', started = false;
          for (let i = 0; i <= N; i++) {
            const t = t0 + span * (i / N);
            const x = X(t), y = Y(valueAt(s, t));
            if (t <= tNow) { d += (started ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); started = true; }
            else dFuture += (dFuture ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
          }
          if (dFuture) parts.push(`<path d="${dFuture}" fill="none" stroke="${col}" stroke-width="1.5" opacity="0.18"/>`);
          if (d) parts.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
        }
        // the playhead, shared with the map
        const px = X(Math.min(t1, Math.max(t0, tNow)));
        parts.push(`<line x1="${px}" y1="${CHART.padT - 4}" x2="${px}" y2="${CHART.h - CHART.padB}" stroke="#9fe8ff" stroke-width="1" opacity="0.8"/>`);
        parts.push(`<text x="${CHART.padL}" y="${CHART.h - 4}" fill="#6d6590" font-size="9">${fmtClock(t0)}</text>`);
        parts.push(`<text x="${CHART.w - CHART.padR}" y="${CHART.h - 4}" fill="#6d6590" font-size="9" text-anchor="end">${fmtClock(t1)}</text>`);
        parts.push(`<text x="${CHART.w / 2}" y="${CHART.h - 4}" fill="#6d6590" font-size="9" text-anchor="middle">${
          norm ? 'share of each metric’s session total' : METRICS.find(m => m.k === picked[0]).label}</text>`);
        svg.innerHTML = parts.join('');
      }
      const fmtClock = t => new Date(t * 1000).toISOString().slice(11, 16);

      // The ratio band: its own strip, its own single 0–100% axis, shared by every ratio because they
      // genuinely share those units. Hidden entirely when no ratio is selected, so it costs nothing.
      const BAND = { w: CHART.w, h: 58, padL: 6, padR: 6, padT: 8, padB: 13 };
      function drawBand(tNow) {
        const svg = document.getElementById('eqtrail-band');
        if (!svg || !O.stats) return;
        const picked = O.opts.series.map(k => METRICS.find(m => m.k === k)).filter(m => m.ratio && hasRatio(m));
        svg.style.display = picked.length ? '' : 'none';
        if (!picked.length) return;
        const { t0, t1 } = O.stats, span = Math.max(1, t1 - t0);
        const X = t => BAND.padL + (BAND.w - BAND.padL - BAND.padR) * ((t - t0) / span);
        const innerH = BAND.h - BAND.padT - BAND.padB;
        const Y = r => BAND.padT + innerH * (1 - r);
        const parts = [];
        for (const g of [0, 0.5, 1]) {
          parts.push(`<line x1="${BAND.padL}" y1="${Y(g)}" x2="${BAND.w - BAND.padR}" y2="${Y(g)}" stroke="#2c2545" stroke-width="1"/>`);
        }
        parts.push(`<text x="${BAND.padL + 2}" y="${Y(1) + 7}" fill="#6d6590" font-size="8">100%</text>`);
        for (const m of picked) {
          const col = seriesColor(m.k);
          const N = 120;
          let d = '', f = '';
          for (let i = 0; i <= N; i++) {
            const t = t0 + span * (i / N), r = ratioAt(m, t);
            if (r == null) continue;                       // no swings yet — draw nothing, don't imply 0%
            const seg = (t <= tNow ? d : f);
            const cmd = (seg ? 'L' : 'M') + X(t).toFixed(1) + ' ' + Y(r).toFixed(1);
            if (t <= tNow) d += cmd; else f += cmd;
          }
          if (f) parts.push(`<path d="${f}" fill="none" stroke="${col}" stroke-width="1.5" opacity="0.18"/>`);
          if (d) parts.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>`);
        }
        const px = X(Math.min(t1, Math.max(t0, tNow)));
        parts.push(`<line x1="${px}" y1="${BAND.padT - 3}" x2="${px}" y2="${BAND.h - BAND.padB}" stroke="#9fe8ff" stroke-width="1" opacity="0.8"/>`);
        parts.push(`<text x="${BAND.w / 2}" y="${BAND.h - 3}" fill="#6d6590" font-size="9" text-anchor="middle">${
          picked.map(m => m.label).join(' · ')} — share of swings so far</text>`);
        svg.innerHTML = parts.join('');
      }

      // ======================= settings persistence =========================
      // Every knob is saved as you move it, so the panel comes back the way it was left. Only the
      // OPTIONS and panel positions are stored — never anything from the log itself, which stays in
      // the tab it was dropped into and is never written anywhere.
      const LS_KEY = 'eqtrail.settings.v1';
      let saveTimer = 0;
      function saveSettings() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          try {
            localStorage.setItem(LS_KEY, JSON.stringify({ opts: O.opts, pos: O.pos, statsOpen: O.statsOpen }));
          } catch (e) { /* private mode, quota — a lost preference is not worth an error */ }
        }, 250);
      }
      function loadSettings() {
        try {
          const raw = localStorage.getItem(LS_KEY);
          if (!raw) return {};
          const s = JSON.parse(raw) || {};
          // Merge over DEFAULTS rather than replacing: a saved blob from an older version must not
          // delete options added since, and a corrupt key must not take the panel down.
          if (s.opts) for (const k of Object.keys(DEFAULTS)) if (k in s.opts) O.opts[k] = s.opts[k];
          if (!Array.isArray(O.opts.series)) O.opts.series = DEFAULTS.series.slice();
          O.opts.series = O.opts.series.filter(k => METRICS.some(m => m.k === k));
          if (s.pos && typeof s.pos === 'object') O.pos = s.pos;
          if (typeof s.statsOpen === 'boolean') O.statsOpen = s.statsOpen;
          return s;
        } catch (e) { return {}; }
      }

      // ========================= draggable panels ===========================
      // The atlas owns the right-hand column and the bottom hint bar; wherever we park a panel it is
      // in someone's way on some window size. Let the reader move it, and remember where they put it.
      function makeDraggable(el, handle, key) {
        handle.style.cursor = 'move';
        handle.addEventListener('pointerdown', e => {
          if (e.target.closest('button, select, input')) return;   // controls in the header still work
          const r = el.getBoundingClientRect();
          const dx = e.clientX - r.left, dy = e.clientY - r.top;
          // Capture keeps the drag alive when the pointer outruns the panel, but it throws if the
          // pointer id is not active (synthetic events, some pen/touch stacks). The drag works without
          // it, so never let a failed capture abort the whole gesture.
          try { handle.setPointerCapture(e.pointerId); } catch (err) {}
          const move = ev => {
            // Clamp so a panel can never be dragged fully off-screen and stranded there.
            const x = Math.min(Math.max(0, ev.clientX - dx), innerWidth - 40);
            const y = Math.min(Math.max(0, ev.clientY - dy), innerHeight - 30);
            el.style.left = x + 'px'; el.style.top = y + 'px';
            el.style.right = 'auto'; el.style.bottom = 'auto';
            O.pos[key] = { x, y };
          };
          const up = ev => {
            try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            saveSettings();
          };
          handle.addEventListener('pointermove', move);
          handle.addEventListener('pointerup', up);
          e.preventDefault();
        });
      }
      function applyPos(el, key) {
        const p = O.pos[key];
        if (!p) return;
        el.style.left = Math.min(p.x, innerWidth - 40) + 'px';
        el.style.top = Math.min(p.y, innerHeight - 30) + 'px';
        el.style.right = 'auto'; el.style.bottom = 'auto';
      }

      // ============================== hide UI ===============================
      // Two levels, because they answer different questions. "Trail" hides only what we added — for
      // looking at the map itself. "All" also hides the site's own chrome and lets the canvas fill the
      // window, which is what you want when recording. Neither is persisted: a reload always brings
      // everything back, so a hidden panel can never become a mystery.
      const SITE_CHROME = ['header.eq-header', 'footer.eq-footer', '#panel', '#wikidock', '#keys',
                           '#worldLegend', '#stage .hud', '#stage #hint'];
      const HIDE_CSS = `
        html.eqt-hide-site ${SITE_CHROME.join(', html.eqt-hide-site ')} { display: none !important; }
        html.eqt-hide-site #atlas { display: block !important; padding: 0 !important; margin: 0 !important;
          max-width: none !important; width: 100vw !important; height: 100vh !important; }
        html.eqt-hide-site #stage { width: 100vw !important; height: 100vh !important; border-radius: 0 !important; }
        html.eqt-hide-site body { overflow: hidden !important; margin: 0 !important; }
        html.eqt-hide-ours #eqtrail-panel, html.eqt-hide-ours #eqtrail-stats { display: none !important; }
        #eqtrail-peek{position:fixed;left:10px;bottom:10px;z-index:100000;
          font:11px/1.4 ui-sans-serif,system-ui,sans-serif;color:#cfc7ea;
          background:rgba(14,12,24,.9);border:1px solid #3a3350;border-radius:8px;
          padding:7px 10px;pointer-events:none;transition:opacity .5s ease;box-shadow:0 4px 14px rgba(0,0,0,.5)}
        #eqtrail-peek.dim{opacity:0;}
        #eqtrail-peek b{color:#9fe8ff;font-family:ui-monospace,monospace}
        html:not(.eqt-hide-site):not(.eqt-hide-ours) #eqtrail-peek{display:none}`;

      function setHidden(ours, site) {
        const r = document.documentElement;
        r.classList.toggle('eqt-hide-ours', !!ours);
        r.classList.toggle('eqt-hide-site', !!site);
        O.hidden = { ours: !!ours, site: !!site };
        let peek = document.getElementById('eqtrail-peek');
        if (!ours && !site) { if (peek) peek.remove(); return; }
        if (!peek) { peek = document.createElement('div'); peek.id = 'eqtrail-peek'; document.body.appendChild(peek); }
        peek.innerHTML = site ? 'All UI hidden — press <b>Shift</b>+<b>H</b> to bring it back'
                              : 'Trail panel hidden — press <b>H</b> to bring it back';
        // Fade the reminder out so it never sits in a recording, but leave it in the DOM: moving the
        // mouse brings it back, so the way out is always one gesture away.
        peek.classList.remove('dim');
        clearTimeout(O._peekT);
        O._peekT = setTimeout(() => peek.classList.add('dim'), 4000);
      }
      function flashPeek() {
        const peek = document.getElementById('eqtrail-peek');
        if (!peek) return;
        peek.classList.remove('dim');
        clearTimeout(O._peekT);
        O._peekT = setTimeout(() => peek.classList.add('dim'), 2500);
      }
      O.setHidden = setHidden;

      function onKey(e) {
        // Never steal a key from a text field, and never from the atlas's own shortcuts — it uses
        // WASD/QE/FG/ZX/CV and Shift; H is free.
        const el = document.activeElement;
        if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'h' || e.key === 'H') {
          e.preventDefault();
          if (e.shiftKey) {
            const on = !(O.hidden && O.hidden.site);
            setHidden(on, on);                       // "all" implies ours
          } else {
            setHidden(!(O.hidden && O.hidden.ours), O.hidden && O.hidden.site);
          }
        }
      }

      // ============================== panel =================================
      const CSS = `
      #eqtrail-panel{position:fixed;right:14px;bottom:14px;z-index:9999;width:262px;
        font:12px/1.45 ui-sans-serif,system-ui,sans-serif;color:#e8e6f2;
        background:rgba(14,12,24,.92);border:1px solid #3a3350;border-radius:10px;
        box-shadow:0 10px 30px rgba(0,0,0,.55);backdrop-filter:blur(6px);overflow:hidden}
      #eqtrail-panel h4{margin:0;padding:9px 11px;font-size:12px;letter-spacing:.09em;text-transform:uppercase;
        background:linear-gradient(90deg,#221c3a,#16122a);border-bottom:1px solid #3a3350;color:#bdb4e6;
        display:flex;justify-content:space-between;align-items:center}
      #eqtrail-panel h4 span{cursor:pointer;color:#7d7495;font-size:14px}
      #eqtrail-body{padding:10px 11px 12px}
      #eqtrail-hud{font:11px ui-monospace,monospace;color:#9fe8ff;margin:2px 0 8px;min-height:15px}
      #eqtrail-note{display:none;font-size:11px;color:#e8c98a;background:#2a2033;border:1px solid #4a3a2a;
        border-radius:6px;padding:6px 8px;margin:0 0 8px;line-height:1.35}
      #eqtrail-panel select{flex:1;background:#221c3a;color:#e8e6f2;border:1px solid #443a68;
        border-radius:6px;padding:3px 5px;font-size:11px;max-width:100%}
      .eqt-row{display:flex;align-items:center;gap:7px;margin:6px 0}
      .eqt-row label{flex:0 0 66px;color:#9d95bb;font-size:11px}
      .eqt-row input[type=range]{flex:1;accent-color:#7c6fe0;height:16px}
      .eqt-row .eqt-v{flex:0 0 34px;text-align:right;font:11px ui-monospace,monospace;color:#cfc7ea}
      #eqtrail-panel button{background:#2a2344;color:#e8e6f2;border:1px solid #443a68;border-radius:6px;
        padding:4px 9px;cursor:pointer;font-size:12px}
      #eqtrail-panel button:hover{background:#372c5c}
      #eqtrail-panel button.on{background:#5a4bb8;border-color:#7c6fe0}
      .eqt-legend{display:flex;align-items:center;gap:6px;margin-top:9px;font-size:10px;color:#8d85ab}
      .eqt-legend i{flex:1;height:7px;border-radius:4px;display:block}
      .eqt-scale{margin-top:10px}
      .eqt-bar{height:8px;border-radius:4px;border:1px solid #2c2545}
      .eqt-ticks{position:relative;height:13px;margin-top:2px}
      .eqt-ticks b{position:absolute;top:0;transform:translateX(-50%);font:10px ui-monospace,monospace;
        font-weight:400;color:#9d95bb;white-space:nowrap}
      .eqt-ticks b:first-child{transform:none}
      .eqt-ticks b:last-child{transform:translateX(-100%)}
      .eqt-cap{margin-top:2px;font-size:10px;color:#7d7495;letter-spacing:.03em}
      #eqtrail-drop{margin-top:9px;border:1px dashed #4a4070;border-radius:7px;padding:9px;text-align:center;
        color:#8d85ab;font-size:11px;cursor:pointer}
      #eqtrail-drop.hot{border-color:#7c6fe0;color:#cfc7ea;background:#221c3a}
      #eqtrail-stat{margin-top:7px;font:10px ui-monospace,monospace;color:#7d7495}
      .eqt-about{margin-top:9px;padding-top:8px;border-top:1px solid #2c2545;
        font-size:10px;color:#6d6590}
      .eqt-aboutbtns{display:flex;align-items:center;gap:6px}
      /* Its own line. Sharing a flex row with the buttons ellipsed "update to 0.8.0" down to "u…",
         which hid the single most useful thing the row can ever say. */
      .eqt-about #eqtrail-ver{font-family:ui-monospace,monospace;margin-bottom:5px;line-height:1.4}
      .eqt-about #eqtrail-ver a{color:#8ee6a0;text-decoration:none;font-weight:600}
      .eqt-about #eqtrail-ver a:hover{text-decoration:underline}
      .eqt-about button{font-size:10px;padding:2px 7px}
      #eqtrail-verlist{margin-top:7px;border:1px solid #2c2545;border-radius:7px;overflow:hidden}
      #eqtrail-verlist a{display:flex;justify-content:space-between;gap:8px;padding:5px 9px;
        font:11px ui-monospace,monospace;color:#cfc7ea;text-decoration:none;border-bottom:1px solid #221c3a}
      #eqtrail-verlist a:last-child{border-bottom:0}
      #eqtrail-verlist a:hover{background:#241d40}
      #eqtrail-verlist a i{color:#6d6590;font-style:normal}
      #eqtrail-verlist a.cur{color:#9fe8ff}
      /* Explicit: this block inherits white-space:nowrap from the panel, which clipped the sentence
         rather than wrapping it (scrollWidth 311 into a 236px box). */
      /* NAME THIS CAREFULLY. It was named .hint once, and the Atlas has its own .hint — the floating
         pill under the 3D view ("scroll to fly toward the cursor…"). Ours silently inherited
         position:absolute, border-radius:999px and pointer-events:none from it, and turned into a
         detached, wildly-rounded bubble that floated over the panel and let clicks fall through to
         the file-drop zone behind it, opening a file dialog. Scoping OUR selector does not help — the
         host's rule is what matches our element — so the class NAME has to be ours alone. Every class
         this overlay adds is prefixed eqt- for that reason. See issue #4. */
      #eqtrail-verlist .eqt-vhint{padding:6px 9px;font-size:10px;color:#6d6590;line-height:1.45;
        background:#171233;white-space:normal}
      #eqtrail-verlist .eqt-vhint a{color:#9fe8ff}
      .eqt-keyhint{margin-top:7px;font-size:10px;color:#6d6590;line-height:1.4}
      .eqt-keyhint b{color:#9fe8ff;font-family:ui-monospace,monospace;font-weight:600}`;

      function gradCss(name) {
        const s = []; for (let i = 0; i <= 8; i++) { const c = ramp(name, i / 8); s.push(`rgb(${(c[0]*255)|0},${(c[1]*255)|0},${(c[2]*255)|0})`); }
        return `linear-gradient(90deg,${s.join(',')})`;
      }
      // The heat bar is LINEAR IN TIME left-to-right; the colour along it follows the same
      // 0.18 + 0.82·wᐟ⁵⁵ mapping the cells use, so a colour read off the map lands on the right
      // tick. (Encoding the ramp linearly instead would silently lie about where "5 minutes" is.)
      const heatU = w => 0.18 + 0.82 * Math.pow(w, 0.55);
      function heatBarCss() {
        const s = [];
        for (let i = 0; i <= 12; i++) {
          const c = ramp('inferno', heatU(i / 12));
          s.push(`rgb(${(c[0]*255)|0},${(c[1]*255)|0},${(c[2]*255)|0}) ${Math.round(i / 12 * 100)}%`);
        }
        return `linear-gradient(90deg,${s.join(',')})`;
      }
      function fmtDur(sec) {
        sec = Math.round(sec);
        if (sec < 60) return sec + 's';
        const m = Math.floor(sec / 60), s = sec % 60;
        if (m < 60) return s ? `${m}m${String(s).padStart(2, '0')}` : `${m}m`;
        return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
      }
      // Ticks in real units — "how long did someone stand on this cell", not an abstract 0..1. The
      // units follow the weighting: seconds for 'time', /loc counts for 'visits'.
      function renderTicks() {
        const box = document.getElementById('eqtrail-ticks'), cap = document.getElementById('eqtrail-cap');
        if (!box) return;
        const h = O.heatStats;
        if (!h || !h.peak) { box.innerHTML = ''; if (cap) cap.textContent = ''; return; }
        const fmt = h.by === 'visits' ? (v => Math.round(v)) : fmtDur;
        box.innerHTML = [0, 0.25, 0.5, 1].map(w =>
          `<b style="left:${(w * 100).toFixed(0)}%">${w === 0 ? '0' : fmt(h.peak * w)}</b>`).join('');
        if (cap) cap.textContent = (h.by === 'visits' ? '/loc samples' : 'time spent') +
          ` per ${Math.round(h.cell * 10)}-loc cell`;
      }
      // One line of plain-language state under the HUD: why nothing drew, which zone is loading.
      function note(msg) {
        const n = document.getElementById('eqtrail-note');
        if (n) { n.textContent = msg || ''; n.style.display = msg ? 'block' : 'none'; }
        if (msg) console.log('[EQTrail] ' + msg);
      }
      function fillSegPicker() {
        const sel = document.getElementById('eqtrail-seg');
        const wrap = document.getElementById('eqtrail-segrow');
        if (!sel || !O.segments) return;
        // Always shown once a log is loaded, even for a single zone: a log covering twelve zones draws
        // one of them, and the reader has to be able to see WHICH — and change it.
        wrap.style.display = 'flex';
        sel.innerHTML = O.segments.map((s, i) =>
          `<option value="${i}">${s.name || 'unknown zone'} · ${s.pts.length} loc${s.pts.length === 1 ? '' : 's'}` +
          (s.visits > 1 ? ` · ${s.visits} visits` : '') + (s.key ? '' : ' · no map') + `</option>`
        ).join('');
      }

      function slider(label, key, min, max, step, fmt, onChange) {
        return `<div class="eqt-row"><label>${label}</label>
          <input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${O.opts[key]}">
          <span class="eqt-v" data-v="${key}">${fmt(O.opts[key])}</span></div>`;
      }

      function buildPanel() {
        const st = document.createElement('style'); st.dataset.eqtrail = '1';
        st.textContent = CSS + HIDE_CSS; document.head.appendChild(st);
        const el = document.createElement('div'); el.id = 'eqtrail-panel';
        el.innerHTML = `<h4>Trail <span id="eqtrail-x" title="close">×</span></h4><div id="eqtrail-body">
          <div id="eqtrail-hud"></div>
          <div id="eqtrail-note"></div>
          <div class="eqt-row" id="eqtrail-segrow" style="display:none"><label>zone</label>
            <select id="eqtrail-seg"></select></div>
          <div class="eqt-row">
            <button id="eqtrail-play">▶</button>
            <input type="range" id="eqtrail-scrub" min="0" max="1000" value="0" style="flex:1">
          </div>
          ${slider('speed', 'speed', 5, 400, 5, v => v + '×')}
          ${slider('trail', 'trail', 0.01, 1, 0.01, v => Math.round(v * 100) + '%')}
          ${slider('ghost', 'future', 0, 0.4, 0.01, v => Math.round(v * 100) + '%')}
          <div class="eqt-row"><label>colour</label>
            <button data-c="time" class="on">time</button><button data-c="speed">speed</button></div>
          <div class="eqt-legend"><span>start</span><i style="background:${gradCss('ice')}"></i><span>end</span></div>
          <hr style="border:0;border-top:1px solid #2c2545;margin:11px 0 8px">
          ${slider('cell', 'cell', 3, 30, 1, v => v)}
          ${slider('relief', 'relief', 0, 6, 0.25, v => v == 0 ? 'flat' : v)}
          ${slider('opacity', 'heatOpacity', 0, 1, 0.02, v => Math.round(v * 100) + '%')}
          <div class="eqt-row"><label>weight</label>
            <button data-w="time" class="on">time</button><button data-w="visits">visits</button></div>
          <hr style="border:0;border-top:1px solid #2c2545;margin:11px 0 8px">
          <div class="eqt-row"><label>gaps</label>
            <button data-g="skip" class="on">skip</button><button data-g="ff">fast fwd</button>
            <button data-g="real">real</button></div>
          ${slider('over', 'gapThreshold', 10, 900, 10, v => fmtDur(v))}
          <div class="eqt-row" id="eqtrail-ffrow" style="display:none">
            <label>speed-up</label>
            <input type="range" data-k="gapFF" min="2" max="60" step="1" value="${O.opts.gapFF}">
            <span class="eqt-v" data-v="gapFF">${O.opts.gapFF}\u00d7</span></div>
          <div class="eqt-row"><label>applies to</label>
            <button data-a="both" class="on">both</button><button data-a="anim">path</button>
            <button data-a="heat">heat</button></div>
          <div id="eqtrail-gapinfo" class="eqt-cap"></div>
          <div class="eqt-row"><label>layers</label>
            <button data-t="pathOn" class="on">path</button><button data-t="heatOn" class="on">heat</button>
            <button data-t="gravesOn" class="on">deaths</button></div>
          <div class="eqt-scale"><div class="eqt-bar" style="background:${heatBarCss()}"></div>
            <div class="eqt-ticks" id="eqtrail-ticks"></div>
            <div class="eqt-cap" id="eqtrail-cap"></div></div>
          <div class="eqt-row"><label>panels</label>
            <button id="eqtrail-statsbtn" class="on">stats</button>
            <button data-o="swapXY">swap X/Y</button></div>
          <div class="eqt-row"><label>hide</label>
            <button id="eqtrail-hideours">trail UI</button>
            <button id="eqtrail-hideall">all UI</button></div>
          <div class="eqt-keyhint">hidden? press <b>H</b> for the panels, <b>Shift</b>+<b>H</b> for everything</div>
          <div id="eqtrail-drop">drop an eqlog_*.txt here</div>
          <div id="eqtrail-stat"></div>
          <div class="eqt-about">
            <div id="eqtrail-ver"></div>
            <div class="eqt-aboutbtns">
            <button id="eqtrail-bug" title="Opens a pre-filled GitHub issue. Includes your version, browser and counts — never your log.">issue</button>
            <button id="eqtrail-idea" title="Suggest a feature — same, pre-filled on GitHub.">idea</button>
            <button id="eqtrail-vers" title="Install a different version">versions</button>
            <button data-o="updateCheck" title="Check the project page once a day for a newer version. Sends nothing — it is a plain fetch of one static file.">updates</button>
            </div>
          </div>
          <div id="eqtrail-verlist" hidden></div></div>`;
        document.body.appendChild(el);

        el.querySelector('#eqtrail-x').onclick = () => O.clear();
        el.querySelector('#eqtrail-play').onclick = () => O.playing ? O.pause() : O.play();
        el.querySelector('#eqtrail-scrub').oninput = e => { O.pause(); O.setT(+e.target.value / 1000); };
        el.querySelectorAll('input[type=range][data-k]').forEach(r => {
          r.oninput = e => {
            const k = e.target.dataset.k, v = +e.target.value;
            O.opts[k] = v;
            el.querySelector(`[data-v="${k}"]`).textContent = fmtOpt(k, v);
            if (k === 'trail' && O.pathMat) O.pathMat.uniforms.uTrail.value = v;
            else if (k === 'future' && O.pathMat) O.pathMat.uniforms.uFuture.value = v;
            else if (k === 'heatOpacity' && O.heat) O.heat.material.opacity = v;
            else if (k === 'cell' || k === 'relief' || k === 'gapThreshold' || k === 'gapFF') { O.rebuild(); stat(); }
            saveSettings();
          };
        });
        el.querySelectorAll('button[data-c]').forEach(b => b.onclick = () => {
          O.opts.colorBy = b.dataset.c;
          el.querySelectorAll('button[data-c]').forEach(x => x.classList.toggle('on', x === b));
          if (O.pathMat) O.pathMat.uniforms.uMode.value = b.dataset.c === 'speed' ? 1 : 0;
          saveSettings();
        });
        el.querySelectorAll('button[data-t]').forEach(b => b.onclick = () => {
          const k = b.dataset.t; O.opts[k] = !O.opts[k];
          b.classList.toggle('on', O.opts[k]); O.rebuild(); saveSettings();
        });
        el.querySelectorAll('button[data-g]').forEach(b => b.onclick = () => {
          O.opts.gapMode = b.dataset.g;
          el.querySelectorAll('button[data-g]').forEach(x => x.classList.toggle('on', x === b));
          el.querySelector('#eqtrail-ffrow').style.display = O.opts.gapMode === 'ff' ? 'flex' : 'none';
          O.rebuild(); saveSettings();
        });
        el.querySelectorAll('button[data-a]').forEach(b => b.onclick = () => {
          O.opts.gapApply = b.dataset.a;
          el.querySelectorAll('button[data-a]').forEach(x => x.classList.toggle('on', x === b));
          O.rebuild(); saveSettings();
        });
        el.querySelectorAll('button[data-w]').forEach(b => b.onclick = () => {
          O.opts.heatBy = b.dataset.w;
          el.querySelectorAll('button[data-w]').forEach(x => x.classList.toggle('on', x === b));
          O.rebuild(); saveSettings();
        });
        el.querySelector('#eqtrail-seg').onchange = e => O.useSegment(+e.target.value);
        el.querySelector('#eqtrail-statsbtn').onclick = () => O.toggleStats();
        el.querySelector('#eqtrail-bug').onclick = () => window.open(issueUrl('bug'), '_blank', 'noopener');
        el.querySelector('#eqtrail-idea').onclick = () => window.open(issueUrl('idea'), '_blank', 'noopener');
        el.querySelector('#eqtrail-vers').onclick = (e) => {
          const box = el.querySelector('#eqtrail-verlist');
          box.hidden = !box.hidden;
          // Show the button as pressed while the list is open. Reported as "not clear how to dismiss":
          // an untoggled button beside an open list gives no hint that it is the way to close it.
          e.currentTarget.classList.toggle('on', !box.hidden);
          if (!box.hidden) { renderVersions(); checkVersion(true); }
        };
        el.querySelector('#eqtrail-hideours').onclick = () => setHidden(true, O.hidden.site);
        el.querySelector('#eqtrail-hideall').onclick = () => setHidden(true, true);
        el.querySelectorAll('button[data-o]').forEach(b => b.onclick = () => {
          const k = b.dataset.o; O.opts[k] = !O.opts[k];
          b.classList.toggle('on', O.opts[k]);
          saveSettings();
          if (k === 'updateCheck') { checkVersion(O.opts[k]); renderVersions(); return; }
          buildStats(); O.rebuild();
        });
        makeDraggable(el, el.querySelector('h4'), 'panel');
        applyPos(el, 'panel');
        // Any pointer movement while something is hidden re-shows the way out.
        addEventListener('pointermove', flashPeek, { passive: true });
        // Toggle buttons are written into the markup with a fixed default 'on'; restore them from the
        // saved options so a reload does not silently disagree with what the map is doing.
        el.querySelectorAll('button[data-c]').forEach(x => x.classList.toggle('on', x.dataset.c === O.opts.colorBy));
        el.querySelectorAll('button[data-w]').forEach(x => x.classList.toggle('on', x.dataset.w === O.opts.heatBy));
        el.querySelectorAll('button[data-t]').forEach(x => x.classList.toggle('on', !!O.opts[x.dataset.t]));
        el.querySelectorAll('button[data-o]').forEach(x => x.classList.toggle('on', !!O.opts[x.dataset.o]));
        syncStatsBtn();
        const drop = el.querySelector('#eqtrail-drop');
        const file = document.createElement('input'); file.type = 'file'; file.accept = '.txt,text/plain'; file.style.display = 'none';
        el.appendChild(file);
        drop.onclick = () => file.click();
        file.onchange = e => e.target.files[0] && O.loadFile(e.target.files[0]);
        ['dragover', 'dragenter'].forEach(n => drop.addEventListener(n, e => { e.preventDefault(); drop.classList.add('hot'); }));
        ['dragleave', 'drop'].forEach(n => drop.addEventListener(n, e => { e.preventDefault(); drop.classList.remove('hot'); }));
        drop.addEventListener('drop', e => {
          const f = e.dataTransfer.files[0]; if (f) O.loadFile(f);
        });
      }
      // Push O.opts back into the controls. The panel is generated from the options, so it starts
      // truthful — but anything that changes an option WITHOUT going through a control (the console,
      // a restored setting, a future preset) would leave the widgets describing a state the map is no
      // longer in. Cheap enough to just re-assert after every rebuild.
      function fmtOpt(k, v) {
        return k === 'speed' ? v + '\u00d7'
          : k === 'cell' ? String(v)
          : k === 'relief' ? (v == 0 ? 'flat' : String(v))
          : k === 'gapThreshold' ? fmtDur(v)
          : k === 'gapFF' ? v + '\u00d7'
          : Math.round(v * 100) + '%';
      }
      function syncControls() {
        const el = document.getElementById('eqtrail-panel'); if (!el) return;
        el.querySelectorAll('input[type=range][data-k]').forEach(r => {
          const k = r.dataset.k, v = O.opts[k];
          if (document.activeElement !== r) r.value = String(v);
          const out = el.querySelector(`[data-v="${k}"]`);
          if (out) out.textContent = fmtOpt(k, v);
        });
        el.querySelectorAll('button[data-g]').forEach(x => x.classList.toggle('on', x.dataset.g === O.opts.gapMode));
        el.querySelectorAll('button[data-a]').forEach(x => x.classList.toggle('on', x.dataset.a === O.opts.gapApply));
        const ff = el.querySelector('#eqtrail-ffrow');
        if (ff) ff.style.display = O.opts.gapMode === 'ff' ? 'flex' : 'none';
        const gi = document.getElementById('eqtrail-gapinfo');
        if (gi) {
          const g = O.gapStats;
          gi.textContent = !g || !g.gaps ? ''
            : O.opts.gapMode === 'real'
              ? `${g.gaps} gaps over ${fmtDur(O.opts.gapThreshold)} — shown in full`
              : `${g.gaps} gaps · ${fmtDur(g.skipped)} of ${fmtDur(g.logSpan)} removed from playback`;
        }
        el.querySelectorAll('button[data-c]').forEach(x => x.classList.toggle('on', x.dataset.c === O.opts.colorBy));
        el.querySelectorAll('button[data-w]').forEach(x => x.classList.toggle('on', x.dataset.w === O.opts.heatBy));
        el.querySelectorAll('button[data-t]').forEach(x => x.classList.toggle('on', !!O.opts[x.dataset.t]));
        el.querySelectorAll('button[data-o]').forEach(x => x.classList.toggle('on', !!O.opts[x.dataset.o]));
      }

      function stat() {
        const s = document.getElementById('eqtrail-stat'); if (!s) return;
        syncControls();
        const h = O.heatStats;
        const zones = O.segments ? O.segments.length : 1;
        s.textContent = `${O.raw.length} locs here` +
          (O.totalPts && O.totalPts !== O.raw.length ? ` of ${O.totalPts} in ${zones} zones` : '') +
          (O.runs > 1 ? ` · ${O.runs} runs` : '') +
          // Say something self-explanatory in all three cases. "5 deaths, none placeable" is the one
          // that matters: a sparse log can easily have deaths in this zone with no /loc within
          // gapBreak of any of them, and silence there looks like a bug rather than missing data.
          (() => {
            const n = (O.graves || []).length, sk = O.gravesSkipped || 0;
            if (!n && !sk) return '';
            if (!n) return ` · ${sk} death${sk === 1 ? '' : 's'}, none placeable`;
            return ` · ${n} death${n === 1 ? '' : 's'}` + (sk ? ` (${sk} unplaceable)` : '');
          })() +
          (O.lone ? ` · ${O.lone} lone` : '') +
          (h ? ` · ${h.cells} cells · ${Math.round(h.cell * 10)} loc/cell` : '');
        renderTicks();
      }
      O._stat = stat;

      // =========================== stats panel ==============================
      const STATS_CSS = `
      #eqtrail-stats{position:fixed;left:14px;top:96px;z-index:9999;width:326px;
        font:12px/1.45 ui-sans-serif,system-ui,sans-serif;color:#e8e6f2;
        background:rgba(14,12,24,.93);border:1px solid #3a3350;border-radius:10px;
        box-shadow:0 10px 30px rgba(0,0,0,.55);backdrop-filter:blur(6px);overflow:hidden}
      #eqtrail-stats h4{margin:0;padding:9px 11px;font-size:12px;letter-spacing:.09em;text-transform:uppercase;
        background:linear-gradient(90deg,#221c3a,#16122a);border-bottom:1px solid #3a3350;color:#bdb4e6;
        display:flex;justify-content:space-between;align-items:center}
      #eqtrail-stats h4 span{cursor:pointer;color:#7d7495;font-size:14px}
      #eqtrail-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:10px}
      .eqt-card{background:#1a1533;border:1px solid #2c2545;border-left:3px solid #2c2545;
        border-radius:7px;padding:6px 8px;cursor:pointer;transition:background .12s ease}
      .eqt-card:hover{background:#241d40}
      .eqt-card.on{background:#241d40}
      .eqt-card .eqt-v{font:600 15px/1.2 ui-monospace,monospace;color:#e8e6f2}
      .eqt-card .eqt-l{font-size:9.5px;color:#8d85ab;letter-spacing:.02em;margin-top:1px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .eqt-card.dead{opacity:.35;cursor:default}
      #eqtrail-chartwrap{padding:0 10px 6px}
      #eqtrail-chart{display:block;width:100%;height:116px;background:#120f26;
        border:1px solid #2c2545;border-radius:7px}
      #eqtrail-band{display:block;width:100%;height:58px;background:#120f26;
        border:1px solid #2c2545;border-top:0;border-radius:0 0 7px 7px;margin-top:-1px}
      #eqtrail-legend{display:flex;flex-wrap:wrap;gap:9px;padding:2px 11px 11px;font-size:10.5px;color:#9d95bb}
      #eqtrail-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}
      #eqtrail-shint{padding:0 11px 10px;font-size:10px;color:#6d6590}`;

      function statsPanel() {
        const st = document.createElement('style'); st.dataset.eqtrail = '1';
        st.textContent = STATS_CSS; document.head.appendChild(st);
        const el = document.createElement('div'); el.id = 'eqtrail-stats';
        el.innerHTML = `<h4>Session <span id="eqtrail-sx" title="close">×</span></h4>
          <div id="eqtrail-cards"></div>
          <div id="eqtrail-chartwrap">
            <svg id="eqtrail-chart" viewBox="0 0 ${CHART.w} ${CHART.h}" preserveAspectRatio="none"></svg>
            <svg id="eqtrail-band" viewBox="0 0 ${BAND.w} ${BAND.h}" preserveAspectRatio="none" style="display:none"></svg>
          </div>
          <div id="eqtrail-legend"></div>
          <div id="eqtrail-shint">click a card to add or remove it from the plot</div>`;
        document.body.appendChild(el);
        el.querySelector('#eqtrail-sx').onclick = () => { O.statsOpen = false; el.style.display = 'none'; saveSettings(); syncStatsBtn(); };
        makeDraggable(el, el.querySelector('h4'), 'stats');
        applyPos(el, 'stats');
        if (!O.statsOpen) el.style.display = 'none';
      }

      // Cards are rebuilt only when the DATA changes; their numbers are updated in place every frame.
      function renderCards() {
        const box = document.getElementById('eqtrail-cards');
        if (!box) return;
        box.innerHTML = METRICS.map(m => {
          const has = m.ratio ? hasRatio(m) : (O.stats && O.stats.S[m.k]);
          const on = O.opts.series.indexOf(m.k) >= 0;
          const col = seriesColor(m.k);
          return `<div class="eqt-card${has ? '' : ' dead'}${on && has ? ' on' : ''}" data-k="${m.k}"
            style="border-left-color:${on && has ? col : '#2c2545'}">
            <div class="eqt-v" data-v="${m.k}">—</div><div class="eqt-l">${m.label}</div></div>`;
        }).join('');
        box.querySelectorAll('.eqt-card:not(.dead)').forEach(c => c.onclick = () => {
          const k = c.dataset.k, i = O.opts.series.indexOf(k);
          if (i >= 0) O.opts.series.splice(i, 1);
          else if (O.opts.series.length < SERIES_HEX.length) O.opts.series.push(k);
          saveSettings(); renderCards(); updateStats(O.t0 + (O.t1 - O.t0) * O.u);
        });
        renderLegend();
      }
      function renderLegend() {
        const lg = document.getElementById('eqtrail-legend');
        if (!lg) return;
        const picked = O.opts.series.filter(k => {
          const m = METRICS.find(x => x.k === k);
          return m.ratio ? hasRatio(m) : (O.stats && O.stats.S[k]);
        });
        // A legend is always present for two or more series, and each entry is a direct label — which
        // is also what makes the palette's tightest CVD pair legal.
        lg.innerHTML = picked.map(k =>
          `<span><i style="background:${seriesColor(k)}"></i>${METRICS.find(m => m.k === k).label}</span>`).join('');
      }

      // Called every frame from applyU: the cards count up and the curves grow with the playhead.
      function updateStats(tNow) {
        if (!O.stats) return;
        for (const m of METRICS) {
          const cell = document.querySelector(`#eqtrail-cards [data-v="${m.k}"]`);
          if (!cell) continue;
          if (m.ratio) { cell.textContent = fmtVal('ratio', ratioAt(m, tNow)); continue; }
          const s = O.stats.S[m.k];
          cell.textContent = s ? fmtVal(m.fmt, valueAt(s, tNow)) : '—';
        }
        drawChart(tNow);
      }
      O._updateStats = updateStats;

      function syncStatsBtn() {
        const b = document.getElementById('eqtrail-statsbtn');
        if (b) b.classList.toggle('on', !!O.statsOpen);
      }
      O.toggleStats = function () {
        O.statsOpen = !O.statsOpen;
        const el = document.getElementById('eqtrail-stats');
        if (el) el.style.display = O.statsOpen ? '' : 'none';
        saveSettings(); syncStatsBtn();
        if (O.statsOpen) updateStats(O.t0 + (O.t1 - O.t0) * O.u);
      };

      // ================================ boot ================================
      loadSettings();
      buildPanel();
      statsPanel();
      renderCards();
      addEventListener('keydown', onKey);
      syncAbout();
      checkVersion(false);
      window.EQTrail = O;
      console.log('[EQTrail] ready — drop a log on the panel. H hides the panels, Shift+H hides all UI.');
    })();
  }
})();
