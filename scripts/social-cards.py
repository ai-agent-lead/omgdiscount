"""Render the social share cards to PNG.

Run after the build, from the repo root:
  node scripts/build.js
  python3 scripts/social-cards.py      (needs: pip install playwright && playwright install chromium)

Reads social-src/*.html (written by build.js) and writes social/<name>.png at 1200x630.
Commit social/ so the build can copy the cards into dist/og/.
"""
import glob
import os
from playwright.sync_api import sync_playwright

SRC = "social-src"
OUT = "social"

os.makedirs(OUT, exist_ok=True)
files = sorted(glob.glob(os.path.join(SRC, "*.html")))
if not files:
    raise SystemExit("no cards in social-src/ — run node scripts/build.js first")

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=1)
    for f in files:
        name = os.path.splitext(os.path.basename(f))[0]
        page.goto("file://" + os.path.abspath(f))
        page.wait_for_load_state("load")
        page.wait_for_timeout(150)
        page.screenshot(path=os.path.join(OUT, name + ".png"), clip={"x": 0, "y": 0, "width": 1200, "height": 630})
        print("wrote", os.path.join(OUT, name + ".png"))
    browser.close()
