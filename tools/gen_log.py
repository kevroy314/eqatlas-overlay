#!/usr/bin/env python3
"""Synthesize an EverQuest log for Ocean of Tears with a plausible /loc-spam track.

Output mimics eqlog_<char>_<server>.txt: a bracketed timestamp per line, and
`Your Location is <north>, <east>, <up>` for /loc — EQ prints Y (north) first.
Mesh<->loc per eqltools atlas/app.js: mesh.x = -east/10, mesh.y = up/10, mesh.z = north/10.
"""
import json, math, random, datetime

random.seed(7)
G = json.load(open('oot_grid.json'))
b0, b1, NX, NZ = G['b0'], G['b1'], G['NX'], G['NZ']
grid = G['grid']


def height(x, z):
    """Bilinear-ish lookup of the raycast ground height at mesh (x,z)."""
    i = (x - b0[0]) / (b1[0] - b0[0]) * NX - 0.5
    j = (z - b0[2]) / (b1[2] - b0[2]) * NZ - 0.5
    i = min(max(i, 0), NX - 1); j = min(max(j, 0), NZ - 1)
    y = grid[int(round(j))][int(round(i))]
    return -2.02 if y < -50 else y


# Waypoint tour: islands found by the raycast sweep, in mesh (x, z).
# dwell = seconds parked there (camping a spawn), speed in mesh units/sec.
TOUR = [
    dict(p=(260, 830), dwell=420, label='south isle camp'),
    dict(p=(150, 600), dwell=0),
    dict(p=(-60, 470), dwell=0),
    dict(p=(-170, 400), dwell=540, label='sisters isle camp'),
    dict(p=(-120, 180), dwell=0),
    dict(p=(150, 175), dwell=90),
    dict(p=(320, 20), dwell=0),
    dict(p=(340, -110), dwell=600, label='east isle camp'),
    dict(p=(150, -300), dwell=0),
    dict(p=(-60, -480), dwell=0),
    dict(p=(-130, -600), dwell=360, label='north isle camp'),
    dict(p=(-140, -760), dwell=0),
    dict(p=(-100, -870), dwell=210),
    dict(p=(-100, -960), dwell=150, label='dock'),
]

SPEED = 4.6          # mesh units/sec ~ EQ run speed (46 loc-units/s)
DT = 3.0             # /loc macro fires every 3s
t = 0.0
pts = []             # (t, mesh x, y, z)


def emit(x, z, t, wobble=0.0):
    y = height(x, z)
    if y < -1.5:                       # over open water: bob at the surface
        y = -2.02 + random.uniform(-0.25, 0.25)
    else:
        y += random.uniform(-0.15, 0.15)
    pts.append((t, x + random.gauss(0, wobble), y, z + random.gauss(0, wobble)))


for k in range(len(TOUR) - 1):
    a, b = TOUR[k]['p'], TOUR[k + 1]['p']
    # camp: a tight random walk around the waypoint (this is what makes heat)
    cx, cy = a
    for _ in range(int(TOUR[k]['dwell'] / DT)):
        t += DT
        r = abs(random.gauss(0, 11))
        th = random.uniform(0, 2 * math.pi)
        emit(cx + r * math.cos(th), cy + r * math.sin(th), t)
    # travel: straight-ish leg with a lateral sine drift so it doesn't look CAD-drawn
    d = math.hypot(b[0] - a[0], b[1] - a[1])
    n = max(2, int(d / (SPEED * DT)))
    px, pz = (b[1] - a[1]) / d, -(b[0] - a[0]) / d
    for i in range(n):
        u = i / n
        drift = 14 * math.sin(u * math.pi * random.uniform(1.5, 3.0))
        t += DT
        emit(a[0] + (b[0] - a[0]) * u + px * drift,
             a[1] + (b[1] - a[1]) * u + pz * drift, t, wobble=1.2)

start = datetime.datetime(2026, 7, 27, 20, 14, 3)
lines = ['[%s] You have entered Ocean of Tears.' % start.strftime('%a %b %d %H:%M:%S %Y')]
for (tt, x, y, z) in pts:
    ts = (start + datetime.timedelta(seconds=tt)).strftime('%a %b %d %H:%M:%S %Y')
    north, east, up = z * 10, -x * 10, y * 10
    lines.append(f'[{ts}] Your Location is {north:.2f}, {east:.2f}, {up:.2f}')
    if random.random() < 0.012:
        lines.append(f'[{ts}] You have slain a sea turtle!')

open('eqlog_Testchar_legends.txt', 'w').write('\n'.join(lines) + '\n')
print(f'{len(pts)} locs over {pts[-1][0]/60:.1f} min -> eqlog_Testchar_legends.txt')
