# docs-site

A zero-dependency static site generator for this repo's documentation. It reads
the markdown already in the tree and emits a browsable HTML site with a
categorized nav — no npm packages, no CDN, no network. The output works offline
and is suitable for GitHub Pages.

## Build

```sh
node docs-site/build.mjs
```

This scans:

- `README.md`, `SECURITY.md`, `CONTRIBUTING.md` (repo root)
- every `*.md` under `docs/` (including `docs/adr/` and `docs/post/`)

and writes one HTML page per doc plus an `index.html` landing page into
`docs-site/out/`. `.md` links between docs are rewritten to the generated
`.html` pages; anchors are preserved. Console output reports how many pages were
rendered and lists any doc that failed to convert.

Re-run the command any time the docs change; `out/` is rebuilt from scratch.

## What it renders

The bundled markdown converter (in `build.mjs`, no external deps) handles the
subset actually used in these docs: headings, ordered/unordered/task lists
(nested), fenced code blocks (HTML-escaped), inline code, bold/italic, links and
images, GFM tables with alignment, blockquotes, and horizontal rules. It is
"correct enough" for this corpus rather than a full CommonMark implementation.

Navigation is grouped into five categories — Getting Started, Operate,
Security & Audit, Design, Reference. The grouping is defined in `build.mjs`;
any doc not explicitly mapped falls back to **Reference**, so newly added docs
still appear without touching the generator.

## Serve locally

```sh
python3 -m http.server -d docs-site/out 8000
# then open http://localhost:8000/
```

Or just open `docs-site/out/index.html` directly in a browser — the pages are
fully self-contained (CSS is inlined), so `file://` works too.

## Deploy to GitHub Pages

Point Pages at the generated `docs-site/out/` directory. Two common options:

- **Actions**: run `node docs-site/build.mjs` in a workflow and upload
  `docs-site/out` as the Pages artifact.
- **Branch/folder**: build locally and publish the contents of
  `docs-site/out/` to your Pages branch (e.g. `gh-pages`).

## Output is gitignored

`docs-site/out/` is generated and should not be committed. The repo's existing
`.gitignore` already has an `out/` rule, which matches a directory named `out`
at any depth — so `docs-site/out/` is ignored automatically. No `.gitignore`
change is required. (Only `docs-site/build.mjs` and this `README.md` are meant
to be tracked.)
