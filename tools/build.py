#!/usr/bin/env python3
"""Wrap eqtrail-overlay.js into the things a friend can actually install, under ./docs.

`eqtrail-overlay.js` stays a plain "run me now" script — paste it into the console of an already
loaded Zone Atlas page and it works. Everything built here is that same file plus a bootstrap that
waits for the page to publish `window.__dbg`, because a userscript or a content script at
document-idle can easily run before app.js (an ES module) has finished.

Output goes to ./docs because that is what GitHub Pages serves. The userscript must live at a real
https URL: Tampermonkey recognises any link ending in `.user.js` and shows its install prompt, and
the @updateURL/@downloadURL below point back at that same address so installs self-update.

    python3 tools/build.py
"""
import json, pathlib, zipfile, datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = (ROOT / 'eqtrail-overlay.js').read_text()
DOCS = ROOT / 'docs'
EXT = DOCS / 'extension'

VERSION = '0.7.2'
REPO = 'https://github.com/kevroy314/eqatlas-overlay'
PAGES = 'https://kevroy314.github.io/eqatlas-overlay'
USER_JS_URL = f'{PAGES}/eqtrail.user.js'

MATCHES = [
    'https://eqltools.com/atlas*',   # the tool as linked from the site nav
    'https://eqltools.com/zones/*',  # canonical per-zone paths
    'https://norrath3d.com/*',       # the standalone shell app.js mentions (atlas-standalone)
]
DESC = ('Drop an EverQuest log onto the EQL Zone Atlas: your /loc track plays back as an animated '
        '3D trail, with a dwell heatmap of where the time actually went.')

# The overlay is generic; the BUILD stamp is injected here so the same source can be a userscript,
# an extension or a console paste and still report which one it is when someone files an issue.
BOOT = """(function () {
  'use strict';
  window.__EQTRAIL_BUILD = { version: '%(version)s', flavour: '%(flavour)s', pinned: %(pinned)s };
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
%(body)s
  }
})();
"""


def check_css_literals(src):
    """A backtick inside one of the CSS template literals does NOT raise a syntax error — the first
    one closes the literal and the next one opens a new one, so the file still parses while the
    stylesheet is silently truncated at that point. `node --check` cannot see it. This can, and it
    has caught it twice: once in a shader comment, once in a CSS comment."""
    for name in ('const CSS = `', 'const STATS_CSS = `'):
        i = src.index(name) + len(name)
        j = src.index('`;', i)
        if '`' in src[i:j]:
            line = src[:i + src[i:j].index('`')].count('\n') + 1
            raise SystemExit(f'BUILD ABORTED: stray backtick inside {name.strip(" =`")} '
                             f'at line {line} — it truncates the stylesheet silently.')


def bundle(flavour, pinned=False, version=VERSION, src=None):
    # Indent the overlay so the wrapped file still reads as one script.
    body = '\n'.join(('    ' + ln) if ln.strip() else ln for ln in (src or SRC).splitlines())
    return BOOT % dict(body=body, version=version, flavour=flavour,
                       pinned='true' if pinned else 'false')


def header_lines(version, pinned):
    """A pinned build deliberately carries NO @updateURL. That is what makes a downgrade stick:
    with an update URL, Tampermonkey would notice the newer version at the other end and quietly
    pull the user straight back to the release they were trying to get away from."""
    h = ['// ==UserScript==',
         '// @name         EQ Trail — /loc path + dwell heatmap for the EQL Zone Atlas',
         f'// @namespace    {REPO}',
         f'// @version      {version}',
         f'// @description  {DESC}',
         f'// @homepageURL  {PAGES}/']
    if not pinned:
        h += [f'// @downloadURL  {USER_JS_URL}', f'// @updateURL    {USER_JS_URL}']
    h += [f'// @match        {m}' for m in MATCHES]
    h += ['// @run-at       document-idle',
          # `none` is REQUIRED: it makes Tampermonkey run us in the PAGE context. Any other
          # grant value puts the script in an isolated sandbox where window.__dbg is invisible.
          '// @grant        none',
          '// ==/UserScript==', '']
    if pinned:
        h = h[:1] + [f'// PINNED BUILD of {version}. No @updateURL, so it will not auto-update away.',
                     '// Install the current release from the install page to rejoin the update channel.'] + h[1:]
    return h


def write_pinned(version, src):
    """One frozen, self-contained copy per released version, so a bad release can be backed out
    from the UI without going and finding a git tag."""
    d = DOCS / 'v' / version
    d.mkdir(parents=True, exist_ok=True)
    body = bundle('userscript', pinned=True, version=version, src=src)
    (d / 'eqtrail.user.js').write_text('\n'.join(header_lines(version, True)) + '\n' + body)
    return d / 'eqtrail.user.js'


def update_versions_json():
    """Accumulates. Each release adds itself; earlier entries are left alone."""
    f = DOCS / 'versions.json'
    data = json.loads(f.read_text()) if f.exists() else {'versions': []}
    entry = {'v': VERSION,
             'date': datetime.date.today().isoformat(),
             'notes': f'{REPO}/releases/tag/v{VERSION}',
             'pinned': f'v/{VERSION}/eqtrail.user.js'}
    data['versions'] = [e for e in data['versions'] if e['v'] != VERSION] + [entry]
    data['versions'].sort(key=lambda e: [int(x) for x in e['v'].split('.')], reverse=True)
    data['latest'] = data['versions'][0]['v']
    data['install'] = 'eqtrail.user.js'
    f.write_text(json.dumps(data, indent=2) + '\n')
    return f


def main():
    check_css_literals(SRC)
    EXT.mkdir(parents=True, exist_ok=True)
    body = bundle('userscript')

    (DOCS / 'eqtrail.user.js').write_text('\n'.join(header_lines(VERSION, False)) + '\n' + body)

    manifest = {
        'manifest_version': 3,
        'name': 'EQ Trail — Zone Atlas overlay',
        'version': VERSION,
        'description': DESC,
        'homepage_url': f'{PAGES}/',
        'content_scripts': [{
            'matches': MATCHES,
            'js': ['eqtrail.js'],
            'run_at': 'document_idle',
            # MAIN world, same reason as @grant none — the default isolated world cannot see
            # window.__dbg. Chrome/Edge 111+, Firefox 128+.
            'world': 'MAIN',
        }],
    }
    (EXT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (EXT / 'eqtrail.js').write_text(bundle('extension'))

    # A zip is the only thing you can hand someone for "Load unpacked" without a git checkout.
    zp = DOCS / 'eqtrail-extension.zip'
    with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in ['manifest.json', 'eqtrail.js']:
            z.write(EXT / f, f)

    pin = write_pinned(VERSION, SRC)
    vj = update_versions_json()

    for p in [DOCS / 'eqtrail.user.js', EXT / 'manifest.json', EXT / 'eqtrail.js', zp, pin, vj]:
        print(f'{p.relative_to(ROOT)}  {p.stat().st_size:,} bytes')


if __name__ == '__main__':
    main()
