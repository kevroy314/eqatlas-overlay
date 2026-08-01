#!/usr/bin/env python3
"""One-off: build a pinned userscript for every released tag, so the rollback list has history.

Normally `build.py` writes the pinned copy for the version it is building, and the list grows one
release at a time. This backfills the releases that happened before pinned builds existed, by
reading each tag's `eqtrail-overlay.js` straight out of git.

    python3 tools/backfill_pinned.py

Safe to re-run: it rewrites the same files byte-for-byte.
"""
import json, subprocess, pathlib, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import build  # noqa: E402  — reuse write_pinned() and the header rules

ROOT = pathlib.Path(__file__).resolve().parent.parent


def tags():
    out = subprocess.check_output(['git', 'tag'], cwd=ROOT).decode().split()
    vs = [t[1:] for t in out if t.startswith('v')]
    return sorted(vs, key=lambda v: [int(x) for x in v.split('.')])


def tag_date(v):
    return subprocess.check_output(
        ['git', 'log', '-1', '--format=%cs', f'v{v}'], cwd=ROOT).decode().strip()


def main():
    f = ROOT / 'docs' / 'versions.json'
    data = json.loads(f.read_text()) if f.exists() else {'versions': []}
    known = {e['v']: e for e in data['versions']}

    for v in tags():
        src = subprocess.check_output(
            ['git', 'show', f'v{v}:eqtrail-overlay.js'], cwd=ROOT).decode()
        p = build.write_pinned(v, src)
        known[v] = {'v': v, 'date': tag_date(v),
                    'notes': f'{build.REPO}/releases/tag/v{v}',
                    'pinned': f'v/{v}/eqtrail.user.js'}
        print(f'  v{v}  {p.stat().st_size:>8,} bytes  {known[v]["date"]}')

    data['versions'] = sorted(known.values(),
                              key=lambda e: [int(x) for x in e['v'].split('.')], reverse=True)
    data['latest'] = data['versions'][0]['v']
    data['install'] = 'eqtrail.user.js'
    f.write_text(json.dumps(data, indent=2) + '\n')
    print(f'\n  docs/versions.json — latest {data["latest"]}, {len(data["versions"])} versions')


if __name__ == '__main__':
    main()
