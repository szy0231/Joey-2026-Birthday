#!/usr/bin/env python3
"""Rebuild public/fonts/ from the @fontsource npm packages.

The Chinese serif is cut down to just the characters that appear in public/*.html,
so rerun this whenever the page copy changes:

    pip install fonttools brotli
    mkdir /tmp/fontsrc && cd /tmp/fontsrc
    npm pack @fontsource/noto-serif-sc @fontsource/cormorant-garamond
    for f in *.tgz; do mkdir "${f%.tgz}" && tar xzf "$f" -C "${f%.tgz}"; done
    python3 scripts/subset-fonts.py /tmp/fontsrc
"""
import glob, shutil, sys
from pathlib import Path
from fontTools import subset

src = Path(sys.argv[1])
root = Path(__file__).resolve().parent.parent
out = root / 'public' / 'fonts'
out.mkdir(parents=True, exist_ok=True)

def find(name):
    hits = glob.glob(str(src / '*' / 'package' / 'files' / name))
    assert hits, f'missing {name} under {src}'
    return hits[0]

chars = set()
for page in (root / 'public').glob('*.html'):
    chars |= {c for c in page.read_text(encoding='utf-8') if ord(c) >= 0x2000}
text = ''.join(sorted(chars))

for weight in (300, 600):
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = ['*']
    font = subset.load_font(find(f'noto-serif-sc-chinese-simplified-{weight}-normal.woff2'), opts)
    s = subset.Subsetter(opts)
    s.populate(text=text)
    s.subset(font)
    subset.save_font(font, str(out / f'serif-sc-{weight}.woff2'), opts)
    shutil.copy(find(f'noto-serif-sc-latin-{weight}-normal.woff2'), out / f'serif-latin-{weight}.woff2')

for a, b in (('500-normal', '500'), ('500-italic', '500i'), ('600-italic', '600i')):
    shutil.copy(find(f'cormorant-garamond-latin-{a}.woff2'), out / f'cormorant-{b}.woff2')

print(f'{len(text)} characters subset; wrote:')
for f in sorted(out.iterdir()):
    print(f'  {f.name}  {f.stat().st_size / 1024:.1f} KB')
