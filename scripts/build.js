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
  const list = programs.filter((p) => p.meta.category === key);
  const items = list
    .map((p) => {
      const amount = p.meta.value === 0 ? "Waived" : money(p.meta.value);
      return `<li><a href="../programs/${esc(p.id)}.html"><b>${esc(p.meta.title)}</b><span>${esc(amount)} · ${esc(p.meta.unit)}</span></a></li>`;
    })
    .join("\n          ");
  return `<h1>${esc(CATEGORIES[key])}</h1>
      <p class="lede">${esc(CAT_DESC[key])} ${list.length} ${list.length === 1 ? "program" : "programs"}.</p>
      <section class="related" style="margin-top:48px">
        <ul class="rel-list">
          ${items}
        </ul>
      </section>`;
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

  // Listing page and its data.
  fs.writeFileSync(path.join(DIST, "index.html"), fill(fs.readFileSync(path.join(TEMPLATE, "index.html"), "utf8"), { FOOTER: footerHtml("") }, path.join(TEMPLATE, "index.html")));
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
        MAIN: programMain(p) + "\n\n      " + relatedHtml(p, programs),
      },
      path.join(TEMPLATE, "program.html")
    );
    fs.writeFileSync(path.join(DIST, "programs", p.id + ".html"), html);
  }

  const shell = (title, description, main) =>
    fill(programTpl, { TITLE: esc(title), DESCRIPTION: esc(description), ROOT: "../", FOOTER: footerHtml("../"), MAIN: main }, path.join(TEMPLATE, "program.html"));

  for (const key of Object.keys(CATEGORIES)) {
    fs.writeFileSync(path.join(DIST, "categories", key + ".html"), shell(`${CATEGORIES[key]} — omgdiscount`, CAT_DESC[key], categoryMain(key, programs)));
  }
  for (const pg of pages) {
    fs.writeFileSync(path.join(DIST, "pages", pg.slug + ".html"), shell(`${pg.meta.title} — omgdiscount`, pg.meta.description, pageMain(pg)));
  }

  console.log(`Built ${programs.length} programs, ${Object.keys(CATEGORIES).length} category pages and ${pages.length} pages into ${path.relative(ROOT, DIST)}/`);
}

build();
