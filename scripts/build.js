#!/usr/bin/env node
/*
 * omgdiscount static build (no dependencies, Node 18+).
 *
 *   node scripts/build.js
 *
 * Input
 *   content/programs/*.md   one OKF-style post per program (YAML frontmatter + markdown body)
 *   template/index.html     listing page shell (renders from dist/data.js in the browser)
 *   template/program.html   detail page shell with {{PLACEHOLDERS}}
 *   logos/*.svg             logo files, copied as-is
 *
 * Output (dist/, wiped on every run)
 *   dist/index.html
 *   dist/data.js            const OFFERS = [...]; const INFO = {...};
 *   dist/programs/<id>.html one static page per program
 *   dist/logos/*.svg
 *
 * Post format: see content/_template.md. Files starting with "_" are skipped.
 * The build fails (exit 1) and lists every problem it finds, so a bad post never ships.
 */
const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

const ROOT = path.resolve(__dirname, "..");
const CONTENT = path.join(ROOT, "content", "programs");
const TEMPLATE = path.join(ROOT, "template");
const LOGOS = path.join(ROOT, "logos");
const DIST = path.join(ROOT, "dist");

const CATEGORIES = { cloud: "Cloud", ai: "AI and models", dev: "Dev tools", ops: "Finance" };
const STAGES = { pre: "Pre-seed", seed: "Seed", a: "Series A+" };
const SECTION_WHAT = "What it is";
const SECTION_USE = "What you can use it for";
const SECTION_WHO = "Who qualifies";
const SECTION_STEPS = "How to apply";

const errors = [];
const fail = (file, msg) => errors.push(`${path.relative(ROOT, file)}: ${msg}`);

// ---------- helpers ----------

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const money = (n) => "$" + n.toLocaleString("en-US");

// Fill {{NAME}} placeholders in one pass, so inserted values are never re-scanned.
function fill(tpl, map, file) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    if (!(key in map)) throw new Error(`${path.relative(ROOT, file)}: unknown placeholder ${m}`);
    return map[key];
  });
}

// Minimal YAML subset: "key: value" lines where value is a double-quoted string, a JSON-style
// array of strings, a number, true/false, empty, or a bare scalar (e.g. a date).
function parseValue(raw) {
  const v = raw.trim();
  if (v === "" || v === "null" || v === "~") return "";
  if (v.startsWith('"') || v.startsWith("[")) return JSON.parse(v);
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parsePost(text, file) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${path.relative(ROOT, file)}: missing frontmatter block`);
  const meta = {};
  m[1].split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith("#")) return;
    const idx = line.indexOf(":");
    if (idx < 1) throw new Error(`${path.relative(ROOT, file)}: bad frontmatter line ${i + 2}: ${line}`);
    const key = line.slice(0, idx).trim();
    try {
      meta[key] = parseValue(line.slice(idx + 1));
    } catch (e) {
      throw new Error(`${path.relative(ROOT, file)}: cannot parse "${key}": ${e.message}`);
    }
  });
  return { meta, sections: parseSections(m[2]) };
}

// "## Heading" starts a section. Blank lines separate paragraphs. "1. text" lines are
// numbered items; a plain line after an item without a blank line continues that item.
function parseSections(body) {
  const out = {};
  let current = null;
  let fresh = true;
  let mode = null;
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      current = h[1];
      out[current] = { paras: [], items: [] };
      fresh = true;
      mode = null;
      continue;
    }
    if (current === null) continue;
    const text = line.trim();
    if (!text) {
      fresh = true;
      continue;
    }
    const sec = out[current];
    const li = text.match(/^\d+\.\s+(.*)$/);
    if (li) {
      sec.items.push(li[1]);
      mode = "item";
    } else if (fresh) {
      sec.paras.push(text);
      mode = "para";
    } else if (mode === "item") {
      sec.items[sec.items.length - 1] += " " + text;
    } else {
      sec.paras[sec.paras.length - 1] += " " + text;
    }
    fresh = false;
  }
  return out;
}

// ---------- load and validate posts ----------

function loadPrograms() {
  if (!fs.existsSync(CONTENT)) throw new Error(`missing ${path.relative(ROOT, CONTENT)}`);
  const files = fs
    .readdirSync(CONTENT)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .sort();
  const programs = [];
  const ids = new Set();

  for (const f of files) {
    const file = path.join(CONTENT, f);
    let post;
    try {
      post = parsePost(fs.readFileSync(file, "utf8"), file);
    } catch (e) {
      errors.push(e.message);
      continue;
    }
    const { meta, sections } = post;

    // OKF: `type` is the only required key.
    if (typeof meta.type !== "string" || !meta.type.trim()) fail(file, "frontmatter `type` is required");
    else if (meta.type !== "program") fail(file, `type must be "program", got "${meta.type}"`);

    const need = (key, ok, what) => {
      if (!ok(meta[key])) fail(file, `${key}: ${what}`);
    };
    need("title", (v) => typeof v === "string" && v.trim(), "required string");
    need("description", (v) => typeof v === "string" && v.trim(), "required one-sentence string");
    need("short", (v) => typeof v === "string" && v.trim(), "required string");
    need("category", (v) => v in CATEGORIES, `one of ${Object.keys(CATEGORIES).join(", ")}`);
    need("value", (v) => typeof v === "number" && v >= 0, "required number >= 0 (0 means waived)");
    need("unit", (v) => typeof v === "string" && v.trim(), "required string");
    need("benefit", (v) => typeof v === "string" && v.trim(), "required string");
    need("elig", (v) => typeof v === "string" && v.trim(), "required string");
    need("ai", (v) => typeof v === "boolean", "required true or false");
    need(
      "stages",
      (v) => Array.isArray(v) && v.length && v.every((s) => s in STAGES),
      `non-empty list from ${Object.keys(STAGES).join(", ")}`
    );
    need("gate", (v) => v === "" || typeof v === "string", "string (empty if none)");
    if (meta.expired !== undefined && typeof meta.expired !== "boolean") fail(file, "expired must be true or false");
    need("logo", (v) => v === "" || typeof v === "string", "string logo file name without .svg (empty if none)");
    need("apply_url", (v) => v === "" || /^https:\/\//.test(v), "https URL to the provider's page (empty if none)");
    need("timestamp", (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v), "ISO date, e.g. 2026-11-10");
    if (meta.logo) {
      if (!fs.existsSync(path.join(LOGOS, meta.logo + ".svg"))) fail(file, `logo "${meta.logo}.svg" not found in logos/`);
    }
    const sec = (name) => sections[name] || { paras: [], items: [] };
    if (!sec(SECTION_WHAT).paras.length) fail(file, `missing "## ${SECTION_WHAT}" section`);
    if (!sec(SECTION_USE).paras.length) fail(file, `missing "## ${SECTION_USE}" section`);
    if (!sec(SECTION_WHO).paras.length) fail(file, `missing "## ${SECTION_WHO}" section`);
    if (sec(SECTION_STEPS).items.length < 2) fail(file, `"## ${SECTION_STEPS}" needs a numbered list of at least 2 steps`);


    const id = slugify(String(meta.title || ""));
    if (!id) fail(file, "title produces an empty id");
    if (ids.has(id)) fail(file, `duplicate program id "${id}"`);
    ids.add(id);

    programs.push({
      id,
      file: f,
      order: typeof meta.order === "number" ? meta.order : Number.MAX_SAFE_INTEGER,
      meta,
      what: sec(SECTION_WHAT).paras.join(" "),
      use: sec(SECTION_USE).paras.join(" "),
      who: sec(SECTION_WHO).paras,
      steps: sec(SECTION_STEPS).items,
    });
  }

  programs.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file));
  return programs;
}

// ---------- renderers ----------

function dataJs(programs) {
  // Keeps the browser contract the listing page already uses: OFFERS rows + INFO keyed by name.
  const json = (v) => JSON.stringify(v, null, 2).replace(/</g, "\\u003c");
  const offers = programs.map((p) => ({
    name: p.meta.title,
    cat: p.meta.category,
    value: p.meta.value,
    unit: p.meta.unit,
    ai: p.meta.ai,
    benefit: p.meta.benefit,
    elig: p.meta.elig,
    stages: p.meta.stages,
    gate: p.meta.gate,
    apply_url: p.meta.apply_url,
    updated: p.meta.timestamp,
    expired: p.meta.expired === true,
  }));
  const info = {};
  programs.forEach((p) => {
    info[p.meta.title] = { short: p.meta.short, logo: p.meta.logo, what: p.what, use: p.use };
  });
  return `// Generated by scripts/build.js from content/programs. Do not edit.\nconst OFFERS = ${json(offers)};\nconst INFO = ${json(info)};\n`;
}

function programMain(p) {
  const m = p.meta;
  const stages = m.stages.map((s) => STAGES[s]).join(", ");
  const amount = m.value === 0 ? "Waived" : money(m.value);
  const logo = m.logo
    ? `<span class="logo"><img src="../logos/${esc(m.logo)}.svg" alt="" onload="this.nextElementSibling.style.display='none'" onerror="this.style.display='none'"><span class="logo-text">${esc(m.short)}</span></span>`
    : `<span class="logo"><span class="logo-text">${esc(m.short)}</span></span>`;
  return `<div class="crumb">
        <span class="tag">${esc(CATEGORIES[m.category])}</span>
        ${m.ai ? `<span class="tag ai">Uses AI</span>` : ""}
        ${m.gate ? `<span class="tag gate">${esc(m.gate)}</span>` : ""}
        ${m.expired ? `<span class="tag gate">Expired</span>` : ""}
      </div>
      ${logo}
      <h1>${esc(m.title)}</h1>
      <p class="lede">${esc(p.what)}</p>

      <div class="layout">
        <div>
          <section class="section">
            <h2>What you get</h2>
            <p>${esc(m.benefit)}.</p>
          </section>
          <section class="section">
            <h2>What you can use it for</h2>
            <p>${esc(p.use)}</p>
          </section>
          <section class="section">
            <h2>Who qualifies</h2>
            ${p.who.map((t) => `<p>${esc(t)}</p>`).join("\n            ")}
          </section>
          <section class="section">
            <h2>How to apply</h2>
            <ol class="steps">${p.steps.map((t) => `<li><span>${esc(t)}</span></li>`).join("")}</ol>
          </section>
        </div>

        <aside class="side" aria-label="Offer summary">
          <p class="amount-value">${esc(amount)}</p>
          <p class="amount-unit">${esc(m.unit)}</p>
          <dl>
            <dt>Stage</dt><dd>${esc(stages)}</dd>
            <dt>Type</dt><dd>${esc(CATEGORIES[m.category])}</dd>
            <dt>Requires</dt><dd>${esc(m.gate || "Nothing extra")}</dd>
          </dl>
          ${m.apply_url ? `<a class="apply" href="${esc(m.apply_url)}" target="_blank" rel="noopener">Apply on provider site</a>` : `<span class="apply off" aria-disabled="true">No provider link yet</span>`}
          <p class="note">Last checked ${esc(m.timestamp)}</p>
        </aside>
      </div>`;
}

function relatedHtml(p, all) {
  const sameCat = all.filter((x) => x.id !== p.id && x.meta.category === p.meta.category).slice(0, 3);
  const others = sameCat.length ? sameCat : all.filter((x) => x.id !== p.id).slice(0, 3);
  const items = others
    .map(
      (r) =>
        `<li><a href="${esc(r.id)}.html"><b>${esc(r.meta.title)}</b><span>${esc(money(r.meta.value))} · ${esc(r.meta.unit)}</span></a></li>`
    )
    .join("");
  return `<section class="related">
        <h2>More in ${esc(CATEGORIES[p.meta.category])}</h2>
        <ul class="rel-list">
          ${items}
        </ul>
      </section>`;
}

// ---------- site pages: footer, categories, static pages ----------

const FOOTER_SITE = [
  ["About", "about"],
  ["Submit an offer", "submit"],
  ["Contact", "contact"],
];

const CAT_DESC = {
  cloud: "Compute, hosting and database credits for early-stage teams.",
  ai: "Model APIs, GPU time and AI platform credits.",
  dev: "Developer tools, CI and deploy services for small teams.",
  ops: "Banking, accounting, payroll and legal help for founders.",
};

function footerHtml(root) {
  const link = ([label, href]) => `<a href="${root}${href}">${esc(label)}</a>`;
  const browse = [["All programs", "index.html"], ...Object.entries(CATEGORIES).map(([k, v]) => [v, `categories/${k}.html`])];
  return `<footer class="site-foot">
    <div class="foot-grid">
      <div class="foot-brand">
        <span class="wordmark"><span class="coin" aria-hidden="true"></span>mg<span class="disc">discount</span></span>
        <p>Startup and AI credits, sorted by what they are worth.</p>
      </div>
      <nav class="foot-col" aria-label="Browse">
        <h3>Browse</h3>
        ${browse.map(link).join("\n        ")}
      </nav>
      <nav class="foot-col" aria-label="Site">
        <h3>Site</h3>
        ${FOOTER_SITE.map(([label, slug]) => link([label, `pages/${slug}.html`])).join("\n        ")}
      </nav>
    </div>
    <div class="foot-base">
      <p>Check each provider's current terms, stage rules and eligibility on the provider's site before you apply. Logos are single-colour marks from Simple Icons (CC0); brand names belong to their owners.</p>
      <p class="credit">This list is maintained by the <a href="https://datahashi.com" target="_blank" rel="noopener">Datahashi</a> team. Thank you for the buttons, soft shadows and dot grid this page is styled after.</p>
    </div>
  </footer>`;
}

function loadPages() {
  const dir = path.join(ROOT, "content", "pages");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .sort()
    .map((f) => {
      const file = path.join(dir, f);
      let post;
      try {
        post = parsePost(fs.readFileSync(file, "utf8"), file);
      } catch (e) {
        errors.push(e.message);
        return null;
      }
      const { meta, sections } = post;
      if (meta.type !== "page") fail(file, 'type must be "page"');
      if (typeof meta.title !== "string" || !meta.title.trim()) fail(file, "title is required");
      if (typeof meta.description !== "string" || !meta.description.trim()) fail(file, "description is required");
      if (!Object.keys(sections).length) fail(file, "needs at least one ## section");
      return { slug: f.replace(/\.md$/, ""), meta, sections };
    })
    .filter(Boolean);
}

function pageMain(pg) {
  const body = Object.entries(pg.sections)
    .map(([heading, sec]) => {
      const paras = sec.paras.map((t) => `<p>${esc(t)}</p>`).join("\n            ");
      const items = sec.items.length
        ? `<ol class="steps">${sec.items.map((t) => `<li><span>${esc(t)}</span></li>`).join("")}</ol>`
        : "";
      return `<section class="section">
            <h2>${esc(heading)}</h2>
            ${paras}
            ${items}
          </section>`;
    })
    .join("\n          ");
  return `<h1>${esc(pg.meta.title)}</h1>
      <p class="lede">${esc(pg.meta.description)}</p>
      <div style="max-width:680px;margin-top:40px">
          ${body}
      </div>`;
}

function categoryMain(key, programs) {
  const list = programs.filter((p) => p.meta.category === key && !p.meta.expired);
  const items = list
    .map((p) => {
      const amount = p.meta.value === 0 ? "" : money(p.meta.value) + " · ";
      return `<li><a href="../programs/${esc(p.id)}.html"><b>${esc(p.meta.title)}</b><span>${esc(amount)}${esc(p.meta.unit)}</span></a></li>`;
    })
    .join("\n          ");
  return `<h1>${esc(CATEGORIES[key])}</h1>
      <p class="lede">${esc(CAT_DESC[key])} ${list.length ? `${list.length} ${list.length === 1 ? "program" : "programs"}.` : "No programs listed yet."}</p>
      <section class="related" style="margin-top:48px">
        <ul class="rel-list">
          ${items}
        </ul>
      </section>`;
}


// ---------- social cards and share tags ----------
// Each card is drawn as SVG and rendered to PNG during the build (no browser needed),
// so the Cloudflare build produces every card from the posts.

const SITE = "https://omgdiscount.com";
const FONT_DIR = path.join(TEMPLATE, "fonts");
const CARD_W = 1200;
const CARD_H = 630;

const ink = { bg: "#0f172a", text: "#f8fafc", muted: "#c4cbd6", faint: "#a3adbd", gold: "#fcd34d", tag: "#a5b4fc" };

// Greedy word wrap; the last line is shortened with an ellipsis when there are too many lines.
function wrapText(text, maxChars, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s*\S*$/, "") + "…";
    return kept;
  }
  return lines;
}

function truncate(text, max) {
  const t = String(text);
  return t.length <= max ? t : t.slice(0, max - 1).replace(/\s*\S*$/, "") + "…";
}

// Inline a single-colour logo SVG, recoloured to the card's text colour.
function inlineLogo(name, x, y, w, h) {
  if (!name) return "";
  const file = path.join(LOGOS, name + ".svg");
  if (!fs.existsSync(file)) return "";
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(/<svg[^>]*viewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>/);
  if (!m) return "";
  const inner = m[2].replace(/fill="[^"]*"/g, `fill="${ink.text}"`);
  return `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${m[1]}" preserveAspectRatio="xMaxYMid meet"><g fill="${ink.text}">${inner}</g></svg>`;
}

function cardSvg({ category, title, value, unit, footnote, logo }) {
  const titleLines = wrapText(title, 26, 2);
  const titleSvg = titleLines
    .map((line, i) => `<text x="72" y="${360 + i * 66}" font-size="60" font-weight="700" fill="${ink.text}" letter-spacing="-1.5">${esc(line)}</text>`)
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
  <defs>
    <pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.5" fill="#ffffff" fill-opacity="0.10"/></pattern>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0%" stop-color="#5d61ec" stop-opacity="0.55"/><stop offset="100%" stop-color="#5d61ec" stop-opacity="0"/></radialGradient>
    <radialGradient id="coin" cx="0.35" cy="0.3" r="0.75"><stop offset="0%" stop-color="#fde68a"/><stop offset="48%" stop-color="#f5b82e"/><stop offset="100%" stop-color="#b7791f"/></radialGradient>
  </defs>
  <rect width="${CARD_W}" height="${CARD_H}" fill="${ink.bg}"/>
  <rect width="${CARD_W}" height="${CARD_H}" fill="url(#dots)"/>
  <circle cx="1040" cy="40" r="480" fill="url(#glow)"/>
  <circle cx="88" cy="76" r="15" fill="url(#coin)"/>
  <polygon points="88,66 98,76 88,86 78,76" fill="#1c1917"/>
  <text x="106" y="88" font-size="32" font-weight="700" fill="${ink.text}" letter-spacing="-1">mg<tspan fill="${ink.gold}">discount</tspan></text>
  ${logo}
  <text x="72" y="300" font-size="22" font-weight="700" fill="${ink.tag}" letter-spacing="1">${esc(category.toUpperCase())}</text>
  ${titleSvg}
  <text x="72" y="500" font-size="52" font-weight="700" fill="${ink.gold}" letter-spacing="-1">${esc(value)}</text>
  <text x="72" y="540" font-size="24" fill="${ink.muted}">${esc(unit)}</text>
  <text x="72" y="590" font-size="22" fill="${ink.faint}">${esc(footnote)}</text>
  <text x="1128" y="590" font-size="22" font-weight="700" fill="${ink.text}" text-anchor="end">omgdiscount.com</text>
</svg>`;
}

function renderPng(svg) {
  const fontFiles = ["Inter-Regular.ttf", "Inter-SemiBold.ttf", "Inter-Bold.ttf"].map((f) => path.join(FONT_DIR, f));
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: CARD_W },
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "Inter" },
  });
  return resvg.render().asPng();
}

function programCardPng(p) {
  const m = p.meta;
  const value = m.value === 0 ? "Free" : money(m.value);
  return renderPng(
    cardSvg({
      category: CATEGORIES[m.category],
      title: m.title,
      value,
      unit: truncate(m.unit, 60),
      footnote: truncate(p.what, 60),
      logo: inlineLogo(m.logo, 888, 52, 240, 52),
    })
  );
}

function defaultCardPng(count) {
  return renderPng(
    cardSvg({
      category: "Startup and AI credits",
      title: "Startup and AI credits, sorted by value",
      value: `${count} programs`,
      unit: "Cloud, AI, dev tools and finance for founders",
      footnote: "Check each provider's terms before you apply.",
      logo: "",
    })
  );
}

// Renders every card straight into dist/og/. Called after dist/ is created.
function renderCards(programs) {
  const outDir = path.join(DIST, "og");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "default.png"), defaultCardPng(programs.length));
  for (const p of programs) fs.writeFileSync(path.join(outDir, p.id + ".png"), programCardPng(p));
}

function ogTags({ title, description, image, url }) {
  const t = (s) => esc(s);
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="omgdiscount">`,
    `<meta property="og:title" content="${t(title)}">`,
    `<meta property="og:description" content="${t(description)}">`,
    `<meta property="og:url" content="${t(url)}">`,
    `<meta property="og:image" content="${t(image)}">`,
    `<meta property="og:image:width" content="${CARD_W}">`,
    `<meta property="og:image:height" content="${CARD_H}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${t(title)}">`,
    `<meta name="twitter:description" content="${t(description)}">`,
    `<meta name="twitter:image" content="${t(image)}">`,
  ].join("\n");
}

// ---------- build ----------

function build() {
  const programs = loadPrograms();
  const pages = loadPages();
  for (const [label, slug] of FOOTER_SITE) {
    if (!pages.some((pg) => pg.slug === slug)) errors.push(`footer links to ${label}, but content/pages/${slug}.md is missing`);
  }
  if (errors.length) {
    console.error("Build failed. Fix these posts:\n- " + errors.join("\n- "));
    process.exit(1);
  }
  if (!programs.length) {
    console.error("Build failed: no posts found in content/programs");
    process.exit(1);
  }

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, "programs"), { recursive: true });
  fs.mkdirSync(path.join(DIST, "categories"), { recursive: true });
  fs.mkdirSync(path.join(DIST, "pages"), { recursive: true });

  renderCards(programs);
  const defaultImage = `${SITE}/og/default.png`;

  // Listing page and its data.
  fs.writeFileSync(path.join(DIST, "index.html"), fill(fs.readFileSync(path.join(TEMPLATE, "index.html"), "utf8"), { FOOTER: footerHtml(""), META: ogTags({ title: "omgdiscount — startup and AI credits", description: "Startup and AI credits and discounts, sorted by what they are worth.", image: defaultImage, url: SITE + "/" }) }, path.join(TEMPLATE, "index.html")));
  fs.writeFileSync(path.join(DIST, "data.js"), dataJs(programs));

  // Logos.
  if (fs.existsSync(LOGOS)) fs.cpSync(LOGOS, path.join(DIST, "logos"), { recursive: true });
  for (const f of fs.readdirSync(TEMPLATE).filter((n) => n.startsWith("favicon."))) {
    fs.copyFileSync(path.join(TEMPLATE, f), path.join(DIST, f));
  }

  // One static detail page per program.
  const programTpl = fs.readFileSync(path.join(TEMPLATE, "program.html"), "utf8");
  for (const p of programs) {
    const html = fill(
      programTpl,
      {
        TITLE: esc(`${p.meta.title} — omgdiscount`),
        DESCRIPTION: esc(p.meta.description),
        ROOT: "../",
        FOOTER: footerHtml("../"),
        META: ogTags({ title: `${p.meta.title} — omgdiscount`, description: p.meta.description, image: `${SITE}/og/${p.id}.png`, url: `${SITE}/programs/${p.id}.html` }),
        MAIN: programMain(p) + "\n\n      " + relatedHtml(p, programs),
      },
      path.join(TEMPLATE, "program.html")
    );
    fs.writeFileSync(path.join(DIST, "programs", p.id + ".html"), html);
  }

  const shell = (title, description, main, urlPath) =>
    fill(programTpl, { TITLE: esc(title), DESCRIPTION: esc(description), ROOT: "../", FOOTER: footerHtml("../"), META: ogTags({ title, description, image: defaultImage, url: `${SITE}/${urlPath}` }), MAIN: main }, path.join(TEMPLATE, "program.html"));

  for (const key of Object.keys(CATEGORIES)) {
    fs.writeFileSync(path.join(DIST, "categories", key + ".html"), shell(`${CATEGORIES[key]} — omgdiscount`, CAT_DESC[key], categoryMain(key, programs), `categories/${key}.html`));
  }
  for (const pg of pages) {
    fs.writeFileSync(path.join(DIST, "pages", pg.slug + ".html"), shell(`${pg.meta.title} — omgdiscount`, pg.meta.description, pageMain(pg), `pages/${pg.slug}.html`));
  }

  console.log(`Built ${programs.length} programs, ${Object.keys(CATEGORIES).length} category pages and ${pages.length} pages into ${path.relative(ROOT, DIST)}/`);
}

build();
