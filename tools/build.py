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
import json, pathlib, zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = (ROOT / 'eqtrail-overlay.js').read_text()
DOCS = ROOT / 'docs'
EXT = DOCS / 'extension'

VERSION = '0.5.0'
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

BOOT = """(function () {
  'use strict';
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
%s
  }
})();
"""


def bundle():
    # Indent the overlay so the wrapped file still reads as one script.
    body = '\n'.join(('    ' + ln) if ln.strip() else ln for ln in SRC.splitlines())
    return BOOT % body


def main():
    EXT.mkdir(parents=True, exist_ok=True)
    body = bundle()

    header = ['// ==UserScript==',
              '// @name         EQ Trail — /loc path + dwell heatmap for the EQL Zone Atlas',
              f'// @namespace    {REPO}',
              f'// @version      {VERSION}',
              f'// @description  {DESC}',
              f'// @homepageURL  {PAGES}/',
              f'// @downloadURL  {USER_JS_URL}',
              f'// @updateURL    {USER_JS_URL}']
    header += [f'// @match        {m}' for m in MATCHES]
    header += ['// @run-at       document-idle',
               # `none` is REQUIRED: it makes Tampermonkey run us in the PAGE context. Any other
               # grant value puts the script in an isolated sandbox where window.__dbg is invisible.
               '// @grant        none',
               '// ==/UserScript==', '']
    (DOCS / 'eqtrail.user.js').write_text('\n'.join(header) + '\n' + body)

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
    (EXT / 'eqtrail.js').write_text(body)

    # A zip is the only thing you can hand someone for "Load unpacked" without a git checkout.
    zp = DOCS / 'eqtrail-extension.zip'
    with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in ['manifest.json', 'eqtrail.js']:
            z.write(EXT / f, f)

    for p in [DOCS / 'eqtrail.user.js', EXT / 'manifest.json', EXT / 'eqtrail.js', zp]:
        print(f'{p.relative_to(ROOT)}  {p.stat().st_size:,} bytes')


if __name__ == '__main__':
    main()
