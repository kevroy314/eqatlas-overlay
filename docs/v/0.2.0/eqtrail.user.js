// ==UserScript==
// PINNED BUILD of 0.2.0. No @updateURL, so it will not auto-update away.
// Install the current release from the install page to rejoin the update channel.
// @name         EQ Trail — /loc path + dwell heatmap for the EQL Zone Atlas
// @namespace    https://github.com/kevroy314/eqatlas-overlay
// @version      0.2.0
// @description  Drop an EverQuest log onto the EQL Zone Atlas: your /loc track plays back as an animated 3D trail, with a dwell heatmap of where the time actually went.
// @homepageURL  https://kevroy314.github.io/eqatlas-overlay/
// @match        https://eqltools.com/atlas*
// @match        https://eqltools.com/zones/*
// @match        https://norrath3d.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  window.__EQTRAIL_BUILD = { version: '0.2.0', flavour: 'userscript', pinned: true };
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
     *      EQ's /loc prints "north, east, up" (Y first). We use __dbg.locToMesh when present.
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
     *     EQTrail.loadPoints(pts) [{t:<epoch seconds>, north, east, up}, ...] — skip the parser
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
        maxGap: 30,             // seconds any one sample may claim (an AFK gap is not standing still)
        // Break the ribbon when consecutive samples are further apart than this. A real log is not a
        // continuous track: the macro stops, you camp, you log out, you come back three days later —
        // and every zone visit gets merged into one series. Without a break the tube draws a confident
        // straight line across the whole zone between two samples that have nothing to do with
        // each other. 5 minutes is long enough to keep a genuine run intact.
        gapBreak: 300,
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
      // EQ writes one bracketed timestamp per line. The only positional line vanilla EQ emits is
      // /loc: "Your Location is <north>, <east>, <up>". Zone lines let us pick the right map.
      const RE_LINE = /^\[(\w{3}) (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})\]\s*(.*)$/;
      const RE_LOC  = /^Your Location is\s*(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/i;
      const RE_ZONE = /^You have entered ([^.]+)\./i;
      const MON = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };

      // One line of a log. Cheap `indexOf` guards come FIRST: a real log is overwhelmingly combat
      // spam — 1.5 million lines for 26 /locs is a normal ratio — and running two regexes over every
      // one of them is the difference between a snappy parse and a hung tab.
      function eatLine(raw, out, zones) {
        const isLoc = raw.indexOf('Your Location is') >= 0;
        if (!isLoc && raw.indexOf('You have entered') < 0) return;
        const m = RE_LINE.exec(raw.charCodeAt(raw.length - 1) === 13 ? raw.slice(0, -1) : raw);
        if (!m) return;
        const t = Date.UTC(+m[7], MON[m[2]], +m[3], +m[4], +m[5], +m[6]) / 1000;
        if (isLoc) {
          const l = RE_LOC.exec(m[8]);
          if (l) out.push({ t, north: +l[1], east: +l[2], up: +l[3] });
        } else {
          const z = RE_ZONE.exec(m[8]);
          if (z) zones.push({ t, name: z[1].trim() });
        }
      }

      function finish(out, zones) {
        out.sort((a, b) => a.t - b.t);
        spreadWithinSecond(out);
        return { pts: out, zones };
      }

      function parseLog(text) {
        const out = [], zones = [];
        for (const raw of text.split('\n')) eatLine(raw, out, zones);
        return finish(out, zones);
      }

      // Real logs are enormous — 121 MB and 1.5 million lines is an ordinary one. Reading that with
      // file.text() materialises the whole thing as a JS string and then split() explodes it into a
      // million more, which is how you get a dead tab. Walk the File in slices instead, carry the
      // partial last line across the boundary, and keep only the handful of lines that matter.
      async function parseFile(file, onProgress) {
        const CHUNK = 4 << 20;                       // 4 MiB — big enough to be cheap, small enough to yield
        const dec = new TextDecoder('utf-8');
        const out = [], zones = [];
        let carry = '';
        for (let off = 0; off < file.size; off += CHUNK) {
          const buf = await file.slice(off, off + CHUNK).arrayBuffer();
          // stream:true so a multi-byte character split across the slice boundary survives
          const text = carry + dec.decode(new Uint8Array(buf), { stream: true });
          const lines = text.split('\n');
          carry = lines.pop();                       // last element is a partial line (or '')
          for (let i = 0; i < lines.length; i++) eatLine(lines[i], out, zones);
          if (onProgress) onProgress(Math.min(1, (off + CHUNK) / file.size));
          await new Promise(r => setTimeout(r, 0));  // hand the frame back so playback keeps running
        }
        if (carry) eatLine(carry, out, zones);
        return finish(out, zones);
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
      const locToMesh = D.locToMesh || ((e, n, u) => new T.Vector3(-e / 10, u / 10, n / 10));

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
      };

      function detach() {
        for (const o of [...O.tubes, O.heat, O.head, O.beam]) {
          if (o && o.parent) o.parent.remove(o);
          if (o && o.geometry) o.geometry.dispose();
        }
        // The tubes SHARE one material — dispose it once, not once per run.
        if (O.pathMat) O.pathMat.dispose();
        for (const o of [O.heat, O.head, O.beam]) if (o && o.material) o.material.dispose();
        O.tubes = []; O.runs = 0; O.lone = 0;
        O.tube = O.pathMat = O.heat = O.head = O.beam = null;
      }

      O.clear = function () {
        O.playing = false; cancelAnimationFrame(O._raf);
        detach(); O.raw = [];
        const p = document.getElementById('eqtrail-panel'); if (p) p.remove();
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

      function accept({ pts, zones }) {
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
        // A gap in /loc spam is not 40 minutes of standing still — it's the macro stopping. Clamp the
        // dwell any one sample can claim, or one AFK gap eats the whole colour range.
        const dts = [];
        for (let i = 0; i < S.length; i++) {
          const a = i > 0 ? S[i].t - S[i - 1].t : 0, b = i < S.length - 1 ? S[i + 1].t - S[i].t : 0;
          dts.push(Math.min((a + b) / 2 || 1, 30));
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
      function applyU() {
        if (O.pathMat) O.pathMat.uniforms.uHead.value = O.u;
        if (!O.raw.length) return;
        const tNow = O.t0 + (O.t1 - O.t0) * O.u;
        // walk to the sample at/just before tNow (binary search — the scrubber can jump)
        let lo = 0, hi = O.raw.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (O.raw[mid].t <= tNow) lo = mid; else hi = mid - 1; }
        const a = O.raw[lo], b = O.raw[Math.min(O.raw.length - 1, lo + 1)];
        const k = b.t > a.t ? (tNow - a.t) / (b.t - a.t) : 0;
        const p = locToMesh(a.east + (b.east - a.east) * k, a.north + (b.north - a.north) * k, a.up + (b.up - a.up) * k);
        if (O.head) { O.head.position.copy(p); O.head.position.y += O.opts.yLift; O.head.visible = O.opts.pathOn; }
        if (O.beam && D.Z) {
          const bb = D.Z.atlas.bounds, pa = O.beam.geometry.attributes.position;
          pa.setXYZ(0, p.x, bb.min[1] - 5, p.z); pa.setXYZ(1, p.x, bb.max[1] + 5, p.z);
          pa.needsUpdate = true; O.beam.computeLineDistances(); O.beam.visible = O.opts.pathOn;
        }
        const hud = document.getElementById('eqtrail-hud');
        if (hud) {
          const d = new Date(tNow * 1000);
          hud.textContent = `${d.toISOString().slice(11, 19)}  ·  ${a.north.toFixed(0)}, ${a.east.toFixed(0)}, ${a.up.toFixed(0)}`;
        }
        const sc = document.getElementById('eqtrail-scrub');
        if (sc && document.activeElement !== sc) sc.value = String(Math.round(O.u * 1000));
      }

      O.setT = function (u) { O.u = Math.min(1, Math.max(0, u)); applyU(); };
      O.pause = function () { O.playing = false; cancelAnimationFrame(O._raf); syncBtn(); };
      O.play = function () {
        if (O.playing) return;
        O.playing = true; O._last = performance.now(); syncBtn();
        const tick = (now) => {
          if (!O.playing) return;
          const dt = (now - O._last) / 1000; O._last = now;
          const span = Math.max(1, O.t1 - O.t0);
          O.u += (O.opts.speed * dt) / span;
          if (O.u >= 1) { O.u = 0; }            // loop
          applyU();
          O._raf = requestAnimationFrame(tick);
        };
        O._raf = requestAnimationFrame(tick);
      };
      function syncBtn() { const b = document.getElementById('eqtrail-play'); if (b) b.textContent = O.playing ? '⏸' : '▶'; }

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
      .eqt-row .v{flex:0 0 34px;text-align:right;font:11px ui-monospace,monospace;color:#cfc7ea}
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
      #eqtrail-stat{margin-top:7px;font:10px ui-monospace,monospace;color:#7d7495}`;

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
          <span class="v" data-v="${key}">${fmt(O.opts[key])}</span></div>`;
      }

      function buildPanel() {
        const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
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
          <div class="eqt-row"><label>layers</label>
            <button data-t="pathOn" class="on">path</button><button data-t="heatOn" class="on">heat</button></div>
          <div class="eqt-scale"><div class="eqt-bar" style="background:${heatBarCss()}"></div>
            <div class="eqt-ticks" id="eqtrail-ticks"></div>
            <div class="eqt-cap" id="eqtrail-cap"></div></div>
          <div id="eqtrail-drop">drop an eqlog_*.txt here</div>
          <div id="eqtrail-stat"></div></div>`;
        document.body.appendChild(el);

        el.querySelector('#eqtrail-x').onclick = () => O.clear();
        el.querySelector('#eqtrail-play').onclick = () => O.playing ? O.pause() : O.play();
        el.querySelector('#eqtrail-scrub').oninput = e => { O.pause(); O.setT(+e.target.value / 1000); };
        el.querySelectorAll('input[type=range][data-k]').forEach(r => {
          r.oninput = e => {
            const k = e.target.dataset.k, v = +e.target.value;
            O.opts[k] = v;
            el.querySelector(`[data-v="${k}"]`).textContent =
              k === 'speed' ? v + '×' : k === 'cell' ? v : k === 'relief' ? (v == 0 ? 'flat' : v) : Math.round(v * 100) + '%';
            if (k === 'trail' && O.pathMat) O.pathMat.uniforms.uTrail.value = v;
            else if (k === 'future' && O.pathMat) O.pathMat.uniforms.uFuture.value = v;
            else if (k === 'heatOpacity' && O.heat) O.heat.material.opacity = v;
            else if (k === 'cell' || k === 'relief') { O.rebuild(); stat(); }
          };
        });
        el.querySelectorAll('button[data-c]').forEach(b => b.onclick = () => {
          O.opts.colorBy = b.dataset.c;
          el.querySelectorAll('button[data-c]').forEach(x => x.classList.toggle('on', x === b));
          if (O.pathMat) O.pathMat.uniforms.uMode.value = b.dataset.c === 'speed' ? 1 : 0;
        });
        el.querySelectorAll('button[data-t]').forEach(b => b.onclick = () => {
          const k = b.dataset.t; O.opts[k] = !O.opts[k];
          b.classList.toggle('on', O.opts[k]); O.rebuild();
        });
        el.querySelectorAll('button[data-w]').forEach(b => b.onclick = () => {
          O.opts.heatBy = b.dataset.w;
          el.querySelectorAll('button[data-w]').forEach(x => x.classList.toggle('on', x === b));
          O.rebuild();
        });
        el.querySelector('#eqtrail-seg').onchange = e => O.useSegment(+e.target.value);
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
      function stat() {
        const s = document.getElementById('eqtrail-stat'); if (!s) return;
        const h = O.heatStats;
        const zones = O.segments ? O.segments.length : 1;
        s.textContent = `${O.raw.length} locs here` +
          (O.totalPts && O.totalPts !== O.raw.length ? ` of ${O.totalPts} in ${zones} zones` : '') +
          (O.runs > 1 ? ` · ${O.runs} runs` : '') +
          (O.lone ? ` · ${O.lone} lone` : '') +
          (h ? ` · ${h.cells} cells · ${Math.round(h.cell * 10)} loc/cell` : '');
        renderTicks();
      }
      O._stat = stat;

      buildPanel();
      window.EQTrail = O;
      console.log('[EQTrail] ready — EQTrail.loadLog(text) or drop a log on the panel');
    })();
  }
})();
