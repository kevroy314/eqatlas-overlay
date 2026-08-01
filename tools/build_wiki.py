#!/usr/bin/env python3
"""Generate docs/wiki/*.html from the page bodies below.

Why a generator rather than nine hand-written files: the navigation, the header and the footer
appear on every page, and a wiki grows. Nine copies of a nav is nine chances for one of them to
fall behind — and pages that disagree about what exists stop reading as one thing. Here the nav is
declared once, in NAV.

The output is committed, so GitHub Pages serves plain static HTML with no build step in the middle.
Edit the bodies here, re-run, commit both.

    python3 tools/build_wiki.py
"""
import pathlib, html

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs' / 'wiki'

# (section, [(slug, nav label)])
NAV = [
    ('Start here', [('index', 'Overview'), ('install', 'Install & update'), ('logs', 'Your log file')]),
    ('The map', [('trail', 'The trail'), ('heatmap', 'The heatmap'), ('gaps', 'Long gaps'),
                 ('deaths', 'Deaths')]),
    ('Panels', [('session', 'Session stats'), ('interface', 'Panels & hotkeys')]),
    ('Help', [('faq', 'FAQ')]),
]

SHELL = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — EQ Trail wiki</title>
<meta name="description" content="{desc}">
<link rel="stylesheet" href="wiki.css">
</head>
<body>
<div class="shell">
<nav class="side">
  <a class="brand" href="index.html">EQ&nbsp;Trail<span>.</span></a>
  <div class="tag">wiki</div>
  <div class="cols">
{nav}
  </div>
</nav>
<main>
<h1>{h1}</h1>
<p class="lede">{lede}</p>
{body}
<footer>
  <a href="../index.html">← Install page</a> ·
  <a href="https://github.com/kevroy314/eqatlas-overlay">Source</a> ·
  <a href="https://github.com/kevroy314/eqatlas-overlay/blob/main/CHANGELOG.md">Changelog</a><br><br>
  A fan tool. Zone geometry, maps and data are © <a href="https://eqltools.com">eqltools.com</a> —
  sources at <a href="https://eqltools.com/sources">eqltools.com/sources</a>.
  Not affiliated with EQL&nbsp;Tools or Daybreak Game Company.
</footer>
</main>
</div>
</body>
</html>
"""


def nav_html(current):
    out = []
    for section, items in NAV:
        out.append(f'    <h5>{section}</h5>')
        for slug, label in items:
            on = ' class="on"' if slug == current else ''
            out.append(f'    <a href="{slug}.html"{on}>{label}</a>')
    return '\n'.join(out)


PAGES = {}


def page(slug, title, h1, lede, body, desc=None):
    PAGES[slug] = dict(title=title, h1=h1, lede=lede, body=body.strip(),
                       desc=desc or lede)


# ============================================================================ overview
page('index', 'Overview', 'EQ Trail', """Drop an EverQuest log onto the EQL Zone Atlas and watch
where you actually went — an animated 3D trail of your <code>/loc</code> track, a heatmap of where
the time went, and the numbers from your session counting up alongside it.""", """
<figure>
  <img src="../relief-and-trail.jpg" alt="A glowing trail crosses the Ocean of Tears between islands; orange spikes rise from an island where time was spent.">
  <figcaption>One session in the Ocean of Tears. The trail is coloured by time; the spikes are minutes camped, as height.</figcaption>
</figure>

<h2>What it is</h2>

<p>EQ Trail is an <b>overlay</b>. It runs on top of the
<a href="https://eqltools.com/atlas">EQL Zone Atlas</a> — the real 3D zone geometry, drawn by
someone else's excellent tool — and adds your own data to it. It is not a copy of the Atlas, it
re-hosts no map data, and your log file never leaves your browser.</p>

<div class="note tip">
  <b>Everything happens locally.</b> The log is read and drawn in your own browser. Nothing is
  uploaded, and the page that hands you the script has no server behind it.
</div>

<h2>Where to go</h2>

<div class="cards">
  <a class="card" href="install.html"><b>Install &amp; update →</b>
    <span>Two minutes with Tampermonkey, and it updates itself afterwards.</span></a>
  <a class="card" href="logs.html"><b>Your log file →</b>
    <span>What EQ Trail reads, the <code>/loc</code> macro, and what the numbers mean.</span></a>
  <a class="card" href="trail.html"><b>The trail →</b>
    <span>The animated path: playback, colouring, and why it sometimes breaks.</span></a>
  <a class="card" href="heatmap.html"><b>The heatmap →</b>
    <span>Where the time went — flat on the ground or extruded into relief.</span></a>
  <a class="card" href="gaps.html"><b>Long gaps →</b>
    <span>Camping and AFK time, and how to skip past it.</span></a>
  <a class="card" href="deaths.html"><b>Deaths →</b>
    <span>A gravestone where you died, revealed as playback reaches it.</span></a>
  <a class="card" href="session.html"><b>Session stats →</b>
    <span>Eleven numbers from your log, animated with the playback.</span></a>
  <a class="card" href="interface.html"><b>Panels &amp; hotkeys →</b>
    <span>Dragging, hiding the UI for a recording, saved settings.</span></a>
  <a class="card" href="faq.html"><b>FAQ →</b>
    <span>Nothing showed up · trail in the wrong place · odd-looking heatmap.</span></a>
</div>

<h2>The one-paragraph version</h2>

<p>Install the userscript, open a zone on <a href="https://eqltools.com/atlas">eqltools.com/atlas</a>,
and drop your <code>eqlog_*.txt</code> onto the <b>Trail</b> panel that appears. If your log has
<code>/loc</code> lines in it, you get a trail. If it has combat in it, you get the Session panel too.
Everything else on this wiki is detail.</p>
""")

# ============================================================================ install
page('install', 'Install & update', 'Install &amp; update', """Two minutes, one time. After that it
updates itself.""", """
<h2>Userscript — recommended</h2>

<p>Works the same in Chrome, Edge and Firefox.</p>

<ol>
  <li>Install <b>Tampermonkey</b> from your browser's own extension store —
    <a href="https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo">Chrome</a> ·
    <a href="https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd">Edge</a> ·
    <a href="https://addons.mozilla.org/firefox/addon/tampermonkey/">Firefox</a>.</li>
  <li>Click <a href="../eqtrail.user.js"><b>Install EQ Trail</b></a>. Tampermonkey shows an install
    page — click <b>Install</b>.</li>
  <li>Go to <a href="https://eqltools.com/atlas">eqltools.com/atlas</a> and pick a zone. A
    <b>Trail</b> panel appears bottom-right.</li>
</ol>

<h2>Updating</h2>

<p>The script carries an <code>@updateURL</code>, so Tampermonkey pulls new versions on its own
schedule. To get one immediately: <b>Tampermonkey icon → Check for userscript updates</b>, or simply
click the install link again.</p>

<p>Your saved settings and panel positions survive an update.</p>

<div class="note">
  <b>Only one copy should be installed.</b> Open the Tampermonkey dashboard and check there is a
  single <i>EQ Trail</i> entry. Versions from 0.2.0 onward update in place. If you installed
  <b>0.1.0</b>, that was before the script's identity was stabilised and it shows up as a separate
  entry — delete the older one. (Two copies is not fatal: each one wipes the other's panels on load,
  so you get one working panel rather than two broken ones. It is still worth tidying.)
</div>

<h2>Browser extension instead</h2>

<p><a href="../eqtrail-extension.zip">Download the extension zip</a>, unzip it, then in Chrome or
Edge open <code>chrome://extensions</code>, turn on <b>Developer mode</b>, and choose <b>Load
unpacked</b> → the unzipped folder. Firefox requires signed add-ons for a permanent install, so on
Firefox use the userscript.</p>

<h2>No install at all</h2>

<p>Open a zone on the Atlas, open the developer console, and paste the contents of
<a href="https://github.com/kevroy314/eqatlas-overlay/blob/main/eqtrail-overlay.js"><code>eqtrail-overlay.js</code></a>.
Same overlay — the packaged builds are that file plus a "wait until the page is ready" wrapper. It
lasts until you reload.</p>

<h2>Uninstalling</h2>

<p>Remove the script from the Tampermonkey dashboard (or the extension from
<code>chrome://extensions</code>). To clear saved settings as well, run this in the console on the
Atlas page:</p>

<pre><code>localStorage.removeItem('eqtrail.settings.v1')</code></pre>
""")

# ============================================================================ logs
page('logs', 'Your log file', 'Your log file', """EQ Trail needs exactly one thing from your log:
<code>/loc</code> lines. Everything else it reads is a bonus.""", """
<h2>The line that matters</h2>

<pre><code>[Mon Jul 27 20:14:06 2026] Your Location is 8277.13, -2583.59, 126.62</code></pre>

<p>That is the only line vanilla EverQuest writes that carries a position. Bind <code>/loc</code> to
a macro and let it fire while you play.</p>

<p>The three numbers are <b>east, north, up</b> — X first.</p>

<div class="note">
  <b>That contradicts the usual folklore</b>, which says <code>/loc</code> prints north first. It was
  settled by measurement rather than argument: take every <code>/loc</code> in a log, group by the
  zone it was logged in, and check which reading lands inside that zone's published bounds. Across
  two logs from two different clients — EQ Legends and P1999 Green — "east first" fits every zone
  with samples (8/8 and 8/8), while "north first" falls outside the map in 5 of 8 and 3 of 8.
  <br><br>
  If you ever meet a client that really does print north first, the <b>swap X/Y</b> button flips it.
</div>

<h2>You do not need to log the time</h2>

<p>Every line EQ writes is already stamped with the date and time — that bracket <i>is</i> the time
series. Your macro only has to say <code>/loc</code>.</p>

<p>One consequence: timestamps are whole seconds, so several <code>/loc</code>s inside one second
arrive identical. EQ Trail spreads a same-second run evenly across that second so playback does not
stutter. It invents no positions — it only distributes samples already known to fall inside that
second.</p>

<h2>How often the macro fires changes what the heatmap means</h2>

<p>This is the single most important thing to understand about your own data.</p>

<table>
  <tr><th>If your macro…</th><th>Then…</th></tr>
  <tr><td class="wide"><b>fires on a fixed interval</b> (every few seconds regardless)</td>
      <td>Time and traffic agree. Use <b>weight: time</b>. This is the better data.</td></tr>
  <tr><td class="wide"><b>only fires while you move</b></td>
      <td>Standing still writes nothing, so "time per cell" credits a whole camp to the last sample
          before you stopped. Use <b>weight: visits</b> — it counts samples and is honest about it.</td></tr>
</table>

<h2>Zones</h2>

<p><code>You have entered &lt;Zone&gt;.</code> lines split your session by zone. EQ Trail then:</p>

<ul>
  <li>merges each zone's <b>repeat visits</b> into one series — 100 samples spread over 37 separate
      visits are useless as 37 three-point stubs;</li>
  <li>lists every zone found in the <b>zone</b> dropdown, biggest first, with visit counts;</li>
  <li>starts on <b>the zone you already have open</b>, if your log has samples there, rather than
      yanking you elsewhere;</li>
  <li>marks zones the Atlas has no map for as <code>no map</code>, and draws them on whatever zone
      is open.</li>
</ul>

<h2>Size is not a problem</h2>

<p>Drop the whole thing. Logs are read in 4&nbsp;MiB slices with a cheap filter ahead of the regex,
so nothing large is ever held in memory at once.</p>

<table>
  <tr><th>Real file</th><th>Lines</th><th>Parse time</th></tr>
  <tr><td>121 MB</td><td>1,573,716</td><td>~3 s</td></tr>
  <tr><td>79 MB</td><td>999,925</td><td>~2.6 s</td></tr>
</table>

<p>A progress readout appears in the panel while it works.</p>
""")

# ============================================================================ trail
page('trail', 'The trail', 'The trail', """The animated path: your <code>/loc</code> track played
back over the real zone geometry.""", """
<h2>Playback</h2>

<table>
  <tr><th>Control</th><th>What it does</th></tr>
  <tr><td>▶ / scrub</td><td>Play, pause, or drag to any moment in the session.</td></tr>
  <tr><td>speed</td><td>Log-seconds per real second.</td></tr>
  <tr><td>trail</td><td>How much track stays lit behind the moving head.</td></tr>
  <tr><td>ghost</td><td>Opacity of the route not yet walked. 0 hides it entirely.</td></tr>
  <tr><td>colour</td><td>Tint by <b>time</b> (when you were there) or <b>speed</b> (how fast).</td></tr>
</table>

<p>A white marker leads the trail with a dashed column beneath it, so you can find "now" even when
it is behind a hill. The section of track just behind the head burns brighter and fades out over the
length set by <b>trail</b>.</p>

<h2>Why the trail sometimes breaks</h2>

<p>Consecutive samples more than <b>five minutes</b> apart start a new run rather than joining.
Without that rule, two <code>/loc</code>s from either side of a camp — or from different days
entirely — would be drawn as a confident straight line across the zone, which is a claim your log
never made.</p>

<div class="note">
  <b>This is a drawing rule, not a time rule.</b> It decides where the ribbon is <i>cut</i>. How long
  the playhead <i>lingers</i> in a gap is a separate setting — see <a href="gaps.html">Long gaps</a>.
  They are deliberately independent: tying them together would shred the trail into fragments on a
  <code>/loc</code>-on-move macro.
</div>

<h2>It rides the Atlas's own view</h2>

<p>The trail is added into the Atlas's floor-band groups rather than dropped into the scene, so it
follows the exploded-floors animation, the height slider and the per-floor visibility exactly like
the site's own markers. In a multi-storey zone, pulling the floors apart pulls your trail apart with
them.</p>
""")

# ============================================================================ heatmap
page('heatmap', 'The heatmap', 'The heatmap', """Where the time actually went, binned into cells and
painted onto the zone — flat on the ground, or standing up as relief.""", """
<figure>
  <img src="../heatmap-flat.jpg" alt="An island with the heatmap painted flat across the terrain, magenta at the edges and yellow-white at the centre.">
  <figcaption><b>relief: flat</b> paints the dwell straight onto the ground instead of standing it up.</figcaption>
</figure>

<h2>Controls</h2>

<table>
  <tr><th>Control</th><th>What it does</th></tr>
  <tr><td>cell</td><td>Bin size. The colour bar's caption tells you the real size in loc units.</td></tr>
  <tr><td>relief</td><td><code>flat</code> paints the floor; higher extrudes the heat upward.</td></tr>
  <tr><td>opacity</td><td>How strongly it sits over the terrain.</td></tr>
  <tr><td>weight</td><td><b>time</b> = seconds per cell · <b>visits</b> = number of samples.</td></tr>
</table>

<h2>time vs visits</h2>

<p>Which one is <i>honest</i> depends on your macro — see
<a href="logs.html">Your log file</a>. In short: a fixed-interval <code>/loc</code> makes the two
nearly equivalent and <b>time</b> is the better read; a <code>/loc</code> bound to your movement keys
emits nothing while you stand still, so <b>visits</b> is the truthful choice there and it measures
traffic rather than dwell.</p>

<p>The colour bar is labelled in real units and follows the mode — minutes and seconds per cell, or
sample counts.</p>

<h2>Height comes from your own elevation</h2>

<p>Each cell sits at the median height of the samples in it, taken from the <code>up</code> value in
your log. So in a multi-storey zone the heat lands on the floor you actually walked, with no
raycasting and no guessing.</p>

<h2>Why one cell does not swallow the whole scale</h2>

<p>Long silences are discounted before they become dwell — otherwise a single AFK stretch would take
the top of the colour ramp and flatten everything else into the dark end. How that discount works,
and how to turn it off, is <a href="gaps.html">Long gaps</a>.</p>
""")

# ============================================================================ gaps
page('gaps', 'Long gaps', 'Long gaps', """Camping, AFK, and the boring bits — what to do about the
silences in a <code>/loc</code> stream.""", """
<h2>The problem</h2>

<p>A <code>/loc</code> stream is not continuous. The macro stops, you camp a spawn, you go and make a
coffee. Measured on a real seven-hour session:</p>

<pre><code>58 gaps longer than a minute, totalling 1h50 — 26% of the session</code></pre>

<p>Played back as-is, that is a quarter of the runtime spent watching a dot that is not moving. And
because a zone's repeat visits are merged into one series, it gets worse: in one test log the
Emerald Jungle's two visits are <b>187 days apart</b>. At any playback speed you would care to use,
that session was simply unwatchable before this feature existed.</p>

<h2>The three modes</h2>

<table>
  <tr><th>Mode</th><th>Effect</th></tr>
  <tr><td>skip</td><td>Discard the excess beyond the threshold. <b>The default.</b></td></tr>
  <tr><td>fast fwd</td><td>Divide the excess by the speed-up factor (10× by default).</td></tr>
  <tr><td>real</td><td>A gap is time like any other. Nothing is done.</td></tr>
</table>

<p><b>over</b> sets how long a silence has to be before it counts as a gap (60 s by default).
<b>speed-up</b> is the fast-forward divisor, and only appears in <code>fast fwd</code>. Below the
controls, a line tells you what the current settings are actually doing to your session — for
example <i>"58 gaps · 1h50 of 7h00 removed from playback"</i>.</p>

<h2>applies to — and why it exists</h2>

<p><code>skip</code> deliberately means something <b>different for each layer</b>:</p>

<ul>
  <li><b>Animation</b> — the gap is <i>jumped</i>. There is nothing to watch.</li>
  <li><b>Heatmap</b> — the interval is <i>capped</i> at the threshold, not zeroed. Zeroing it would
      erase a camp from the map entirely, and a camp is exactly the thing the heatmap exists to
      show.</li>
</ul>

<p>Same rule — discard the excess — but a different baseline, because the two layers are asking
different questions about the same silence. On the trail a long pause is dead air; on the map it is
often the most interesting thing in the session.</p>

<p><b>applies to</b> is how you resolve that when the defaults are not what you want:</p>

<table>
  <tr><th>Setting</th><th>Result</th></tr>
  <tr><td>both</td><td>The policy touches the animation and the heat weights. Default.</td></tr>
  <tr><td>path</td><td>Playback skips the dead air; the heatmap counts every second in full.</td></tr>
  <tr><td>heat</td><td>Playback runs in real time; the heatmap discounts long pauses.</td></tr>
</table>

<h2>How it works</h2>

<p>Playback runs on a <b>presentation clock</b>, related to your log's clock by a piecewise-linear
map: ordinary intervals map one-to-one, gaps map through whichever policy you chose. So skipping is
not a special case bolted onto the animation — it is simply a zero-length stretch of that map, and
everything downstream (the trail, the gravestones, the Session numbers) carries on working in real
log time. Only the <i>pacing</i> changes.</p>

<p>Two consequences worth knowing:</p>

<ul>
  <li>The <b>scrubber follows the presentation clock</b>, so dragging it gives even attention to the
      parts of your session where something actually happens.</li>
  <li>Changing the mode <b>keeps you at the same moment</b> in the log rather than at the same
      fraction of the bar — otherwise the playhead would appear to jump every time you touched the
      setting.</li>
</ul>

<div class="note tip">
  <b>While the playhead crosses a compressed gap</b>, the readout at the top of the panel shows how
  long that gap was, so a sudden jump reads as a deliberate skip rather than as a glitch.
</div>

<h2>Not to be confused with the ribbon break</h2>

<p>The trail also <i>breaks</i> when samples are more than five minutes apart. That is a separate,
fixed drawing rule about where the ribbon is cut — see <a href="trail.html">The trail</a>. The gap
settings on this page are about <i>time</i>: how long the playhead lingers and how much dwell a cell
is credited. They are kept independent on purpose.</p>
""")

# ============================================================================ deaths
page('deaths', 'Deaths', 'Deaths', """A gravestone marks each death, appearing in sequence as the
trail reaches it.""", """
<figure>
  <img src="../gravestone.jpg" alt="A pale headstone with a cross standing among trees on an island, with the trail and heatmap around it.">
  <figcaption>A death, marked where the <code>/loc</code> track says you were standing.</figcaption>
</figure>

<p>Toggle them with <b>deaths</b> in the layers row. On by default.</p>

<h2>Where the stone goes</h2>

<p>The death line in your log carries no coordinates — only a time. So the position has to come from
your own <code>/loc</code> track at that timestamp:</p>

<ul>
  <li>If the samples either side are <b>close together</b>, the position is interpolated between
      them.</li>
  <li>If they are <b>far apart</b> — the macro stopped, or you died and stood still — it stays put on
      the last <i>known</i> sample instead of inventing a spot halfway to wherever you went next.</li>
  <li>If there is <b>no sample within five minutes</b>, no stone is placed at all.</li>
</ul>

<div class="note">
  <b>A confident marker in the wrong place is worse than no marker.</b> When deaths cannot be placed,
  the panel says so — <i>"5 deaths, none placeable"</i> — rather than going quietly empty, because
  silence there looks like a bug rather than like missing data.
</div>

<h2>Why you might not see any</h2>

<ul>
  <li><b>They are later in the session than the playhead.</b> Stones appear in sequence. In one real
      log all six deaths fall in the last 90 minutes of a seven-hour session, so nothing shows until
      the scrubber is about three-quarters across.</li>
  <li><b>Your deaths are in a different zone</b> than the one being drawn. Check the <b>zone</b>
      dropdown.</li>
  <li><b>They could not be placed</b> — a sparse log with no <code>/loc</code> near the death. The
      panel will say so.</li>
</ul>

<h2>How it is drawn</h2>

<p>A camera-facing sprite, so the icon stays legible from any orbit angle, drawn with one of
three.js's own materials so it respects the Atlas's logarithmic depth buffer and sits correctly
behind terrain.</p>
""")

# ============================================================================ session
page('session', 'Session stats', 'Session stats', """Eleven numbers read straight out of your log,
all counting up in step with the playback.""", """
<figure>
  <img src="../session.jpg" alt="The Session panel: stat cards above a chart with cumulative curves and a playhead.">
  <figcaption>The Session panel part-way through a real session.</figcaption>
</figure>

<h2>The cards</h2>

<table>
  <tr><th>Card</th><th>Read from</th></tr>
  <tr><td>Damage dealt</td><td><code>You &lt;verb&gt; X for N points of damage</code></td></tr>
  <tr><td>Damage taken</td><td><code>… hits YOU for N points of damage</code></td></tr>
  <tr><td>Kills</td><td><code>You have slain X!</code></td></tr>
  <tr><td>Deaths</td><td><code>You have been slain by X!</code></td></tr>
  <tr><td>Experience</td><td><code>You gain experience! (4.000%)</code></td></tr>
  <tr><td>Levels</td><td><code>You have gained a level!</code></td></tr>
  <tr><td>Coin</td><td><code>You receive … from the corpse</code></td></tr>
  <tr><td>Items looted</td><td><code>You looted X</code></td></tr>
  <tr><td>Distance</td><td>your <code>/loc</code> track itself</td></tr>
  <tr><td>Accuracy</td><td>swings that landed ÷ swings taken</td></tr>
  <tr><td>Evasion</td><td>incoming attacks that missed ÷ attacks at you</td></tr>
</table>

<p><b>Distance</b> is the odd one out — it is measured from your own track rather than from a line of
text, which is why it agrees with the map. It respects the same gap rule as the trail, so a
five-day pause is not counted as a sprint across the zone.</p>

<div class="note">
  <b>How dealt and taken are told apart:</b> <code>YOU</code> in capitals is how EverQuest marks you
  as the <i>target</i> of a swing. Anything else beginning "You&nbsp;…" is you swinging. That single
  distinction splits the whole combat log.
</div>

<h2>The chart</h2>

<p>Click any card to add it to the plot, click again to remove it. Curves are cumulative and are
revealed as the playhead sweeps across, with the part you have not reached yet drawn faint.</p>

<p>With <b>one</b> metric selected the axis is in that metric's own units. With <b>several</b>, each
is drawn as a share of its own session total, and the axis says so.</p>

<div class="note">
  <b>Why not a second y-axis?</b> Because 92,000 damage and 6 deaths have no shared scale, and two
  axes side by side make every crossing point look like a relationship when it is really an artifact
  of whichever ranges were chosen. Normalising to each metric's own total is the honest way to put
  them on one chart.
</div>

<h2>Accuracy and evasion get their own band</h2>

<p>They are percentages, and percentages already carry a natural, self-describing 0–100% scale — so
they share one axis <i>with each other</i>, in a strip beneath the main chart, and none with the
cumulative curves. The band only appears when you select a ratio, and draws nothing before your first
swing rather than implying 0%.</p>

<p>Both are running ratios "so far", matching every other number on the panel, so they settle as the
session goes on rather than twitching fight to fight.</p>
""")

# ============================================================================ interface
page('interface', 'Panels & hotkeys', 'Panels &amp; hotkeys', """Moving things out of the way,
hiding everything for a recording, and what gets remembered.""", """
<h2>Dragging</h2>

<p>Both panels drag by their <b>title bar</b>. They are clamped to the window, so a panel can never
be dragged off-screen and stranded. Where you leave them is remembered.</p>

<h2>Hiding the interface</h2>

<table>
  <tr><th>Key</th><th>Effect</th></tr>
  <tr><td><kbd>H</kbd></td><td>Hide/show the EQ Trail panels.</td></tr>
  <tr><td><kbd>Shift</kbd>+<kbd>H</kbd></td><td>Also hide the Atlas's own header, footer and
      controls, so the map fills the window.</td></tr>
</table>

<p><kbd>Shift</kbd>+<kbd>H</kbd> is the one to use for a screen capture. While anything is hidden, a
small reminder of the key sits in the corner — it fades out so it stays out of your recording, and
comes back the moment you move the mouse.</p>

<div class="note">
  <b>Hiding is never remembered.</b> A reload always brings everything back, so a hidden panel can
  never become a mystery. This is deliberate.
</div>

<p>The keys are ignored while you are typing in a text field, and they do not clash with the Atlas's
own shortcuts (which use WASD, QE, FG, ZX and CV).</p>

<h2>Saved settings</h2>

<p>Every option is saved to your browser's <code>localStorage</code> as you change it — slider
values, toggles, which metrics are plotted, and both panel positions.</p>

<p><b>Nothing from your log is ever stored.</b> It stays in the tab you dropped it into and is gone
when you close it.</p>

<p>To reset everything to defaults, run this in the console on the Atlas page:</p>

<pre><code>localStorage.removeItem('eqtrail.settings.v1')</code></pre>

<h2>Other panel controls</h2>

<table>
  <tr><th>Control</th><th>What it does</th></tr>
  <tr><td>zone</td><td>Every zone found in your log, biggest first. Picking one loads that map.</td></tr>
  <tr><td>layers</td><td>Show or hide the path, the heat and the death markers independently.</td></tr>
  <tr><td>stats</td><td>Show or hide the Session panel.</td></tr>
  <tr><td>swap X/Y</td><td>Flip the <code>/loc</code> column order — see <a href="logs.html">Your log file</a>.</td></tr>
</table>
""")

# ============================================================================ faq
page('faq', 'FAQ', 'FAQ', """The things that actually come up.""", """
<h2>Privacy and safety</h2>

<details><summary>Does my log get uploaded anywhere?</summary><div class="body">
<p>No. The file is read and drawn entirely in your own browser. Nothing is sent anywhere, and the
page that hands you the script has no server behind it — it is static hosting. The only thing saved
is your <i>settings</i>, in your own browser's local storage.</p>
</div></details>

<details><summary>Is this affiliated with EQL Tools?</summary><div class="body">
<p>No. It is a fan tool that runs on top of their Zone Atlas. It re-hosts none of their map data —
it adds objects to the page you already have open, which costs them one ordinary page view. Zone
geometry and data are theirs.</p>
</div></details>

<h2>Nothing is showing up</h2>

<details><summary>I dropped my log and nothing happened</summary><div class="body">
<p>Check the panel — it should tell you. The most common cause is that the log has no
<code>/loc</code> lines at all, in which case it says so explicitly. Vanilla EverQuest only writes a
position when you type <code>/loc</code>, so if your macro was not running, there is nothing to
draw.</p>
</div></details>

<details><summary>The panel never appeared</summary><div class="body">
<p>Make sure you are on a zone page (<code>eqltools.com/atlas?zone=…</code>) and that the 3D view has
finished loading. Open the console: EQ Trail logs <code>[EQTrail] ready</code> when it attaches, and
says so plainly if the page never published the handle it hooks into.</p>
<p>Also check <kbd>H</kbd> — you may have hidden the panels.</p>
</div></details>

<details><summary>My log has thousands of locs but only some are drawn</summary><div class="body">
<p>Only one zone is drawn at a time. The panel's stat line reads something like
<i>"3526 locs here of 3838 in 8 zones"</i> — the rest are in other zones. Use the <b>zone</b>
dropdown.</p>
</div></details>

<h2>It looks wrong</h2>

<details><summary>My trail is in the wrong place, or rotated 90°</summary><div class="body">
<p>Try the <b>swap X/Y</b> button. EQ Trail reads <code>/loc</code> as <b>east, north, up</b>, which
is what two different clients were measured to print. If yours prints north first, that button fixes
it. If it helps, please say so — it would be worth knowing which client does that.</p>
</div></details>

<details><summary>The heatmap is one huge hotspot and everything else is dark</summary><div class="body">
<p>Usually a long AFK or camp soaking up the top of the colour range. Two things to try:</p>
<p>1. Check the <b>gaps</b> setting — with <code>real</code> selected, every second of a two-hour
idle counts in full. <code>skip</code> caps it.</p>
<p>2. Switch <b>weight</b> to <code>visits</code>. If your macro only fires while you move, "time per
cell" is not measuring what you think — see <a href="logs.html">Your log file</a>.</p>
</div></details>

<details><summary>There is a straight line across the zone that I never walked</summary><div class="body">
<p>That should not happen — the trail breaks when samples are more than five minutes apart, exactly
to avoid it. If you are seeing one, the two samples either side are less than five minutes apart but
far away in space, which usually means a zone-out and back, or a death and a bind-point respawn.</p>
</div></details>

<details><summary>My session plays back much faster than it really was</summary><div class="body">
<p>That is <b>gaps: skip</b> doing its job — it removes idle time from the playback. The line under
the gap controls tells you exactly how much was removed. Set it to <code>real</code> for true
one-to-one time.</p>
</div></details>

<details><summary>Why are there no gravestones when I definitely died?</summary><div class="body">
<p>Three possibilities, and the panel usually tells you which: the deaths are later in the session
than the playhead has reached; they are in a different zone; or there was no <code>/loc</code> near
them so no stone could be placed. See <a href="deaths.html">Deaths</a>.</p>
</div></details>

<details><summary>My accuracy seems low</summary><div class="body">
<p>Misses include parries, dodges and blocks, not just clean misses — anything of the form
<i>"You try to X, but …"</i>. A figure around two-thirds is unremarkable.</p>
</div></details>

<h2>Using it</h2>

<details><summary>What macro should I use?</summary><div class="body">
<p>Anything that emits <code>/loc</code> repeatedly. A <b>fixed interval</b> gives the best data,
because then time and traffic agree and <b>weight: time</b> is meaningful. A <code>/loc</code> bound
to your movement keys also works, but it measures traffic rather than dwell — use
<b>weight: visits</b> with that kind of log.</p>
</div></details>

<details><summary>Can I use this with P1999 / Quarm / live EQ?</summary><div class="body">
<p>Yes — any client that writes a standard <code>eqlog_*.txt</code>. It has been tested against logs
from EQ Legends and from P1999 Green. The limit is not the client, it is whether the Atlas has a map
for the zone you were in; zones it does not carry are marked <code>no map</code>.</p>
</div></details>

<details><summary>How do I record a clean video?</summary><div class="body">
<p><kbd>Shift</kbd>+<kbd>H</kbd> hides the Atlas's chrome along with the EQ Trail panels, leaving the
map filling the window. Set up your view and playback speed first, then hide, then record. The
corner reminder fades out on its own so it will not appear in the capture.</p>
</div></details>

<details><summary>Can I see two characters, or two sessions, at once?</summary><div class="body">
<p>Not currently — dropping a second log replaces the first. If that would be useful, it is worth
raising as an issue.</p>
</div></details>

<details><summary>Does it slow my browser down?</summary><div class="body">
<p>Parsing is streamed in slices, so even a 121 MB log parses in about three seconds without
freezing the tab. Drawing is a handful of objects added to a scene the Atlas is already rendering.</p>
</div></details>

<h2>Installing</h2>

<details><summary>How do I force an update?</summary><div class="body">
<p>Tampermonkey icon → <b>Check for userscript updates</b>. Or click the install link again. Your
settings survive.</p>
</div></details>

<details><summary>I think I have two copies installed</summary><div class="body">
<p>Open the Tampermonkey dashboard and look for more than one <i>EQ Trail</i> entry. Versions from
0.2.0 onward update in place; an 0.1.0 install predates that and shows separately. Delete the older
one. Two copies will not break anything visible — each one tears the other's panels down on load, so
you get one working panel — but it is still worth tidying.</p>
</div></details>

<details><summary>Can I use it without Tampermonkey?</summary><div class="body">
<p>Yes — there is an unpacked browser extension, and you can also just paste the script into the
console. See <a href="install.html">Install &amp; update</a>.</p>
</div></details>
""")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for slug, p in PAGES.items():
        page_html = SHELL.format(
            title=html.escape(p['title'], quote=True),
            desc=html.escape(' '.join(p['desc'].split()), quote=True)[:300],
            h1=p['h1'],
            lede=p['lede'],
            nav=nav_html(slug),
            body=p['body'],
        )
        (OUT / f'{slug}.html').write_text(page_html)
        print(f"docs/wiki/{slug}.html  {len(page_html):,} bytes")


if __name__ == '__main__':
    main()
