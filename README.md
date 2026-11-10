# omgdiscount

A list of startup and AI credits and discounts. Each program is a markdown post; a build script turns the posts into the site.

## Layout

```
content/programs/   one post per program (OKF frontmatter + markdown body)
content/programs/_template.md   copy this to start a new post
template/           page shells: index.html (listing) and program.html (detail)
logos/              logo SVGs, referenced by a post's `logo` field
scripts/build.js    the build (Node 18+, no dependencies)
dist/               build output, rebuilt from scratch on every run
```

## Add or change a program

1. Copy `content/programs/_template.md` to a new file, or edit an existing post.
2. Fill the frontmatter. `type: program` and `title` are required. `category` is one of `cloud`, `ai`, `dev`, `ops`. `stages` is a list from `pre`, `seed`, `a`. `value: 0` shows "Waived". `tags` is an optional list of lowercase hyphenated words that drive the tag cloud and `?tag=` filter. Reuse the existing ones before adding a new one: topics (`cloud`, `hosting`, `database`, `gpu`, `ai`, `voice`, `frontend`, `developer-tools`, and one-offs such as `analytics`), program type (`startup-credits`, `student`, `open-source`, `nonprofit`, `research`, `free`, `trial`), and access (`referral` when an investor, accelerator or partner must refer you, `no-funding-needed`). Tag `ai` when the post sets `ai: true`.
3. Write the body under `## What it is` and `## What you can use it for`. Blank lines separate paragraphs. No other markdown is rendered.
4. Build and check:

```
node scripts/build.js
open dist/index.html
```

The build exits with an error and lists every problem it finds, so a broken post never reaches `dist/`.

## Deploy

Cloudflare Pages builds the site from this repo on every push to `main`. Project settings: build command `node scripts/build.js`, build output directory `dist`. No GitHub Actions workflow is used.

## Data

Each post shows its terms and the date they were last checked. Confirm each provider's current terms before relying on them.
