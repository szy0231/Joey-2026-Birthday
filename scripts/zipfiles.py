#!/usr/bin/env python3
"""Write a zip from a manifest of [source path, name in zip] pairs.

Used by scripts/export.mjs. Files are stored without compression (videos do not compress), names are written as
UTF-8 so Chinese names open correctly on Windows and macOS, and ZIP64 kicks in automatically past 4 GB.
"""
import json
import os
import sys
import zipfile

manifest, out = sys.argv[1], sys.argv[2]
with open(manifest, encoding='utf-8') as f:
    items = json.load(f)

total = sum(os.path.getsize(src) for src, _ in items) or 1
done = 0
tmp = out + '.part'
with zipfile.ZipFile(tmp, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as z:
    for src, arc in items:
        z.write(src, arc)
        done += os.path.getsize(src)
        print(f'  {done / total * 100:5.1f}%  {arc}', flush=True)
os.replace(tmp, out)
