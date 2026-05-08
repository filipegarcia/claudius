# Claudius marketing site

Four files. No build step.

```
marketing/
├── index.html    # landing page
├── styles.css    # standalone stylesheet
├── config.js     # site-URL / repo-URL constants (one place to change)
└── setup.sh      # the install script the curl one-liner fetches
```

The page is hand-written HTML/CSS — no framework, no bundler, no
toolchain. That's deliberate: the page exists to render a `curl … | bash`
one-liner before anything else has loaded. It also means GitLab Pages can
serve it as-is.

## Changing the domain

Edit `config.js`:

```js
window.__CLAUDIUS_CONFIG = {
  siteUrl: "https://filipegarcia.gitlab.io/claudius", // ← change here
  repoUrl: "https://gitlab.com/filipegarcia/claudius",
  repoLabel: "GitLab",
};
```

`index.html` reads it on load and rewrites the install command, the "view
the script" link, and the source-code link. Then update the cosmetic
header in `setup.sh` so `--help` prints the same URL — that's it.

The literal URLs in the HTML body act as a no-JS fallback; if a visitor
has scripts disabled they still see a working command. To swap them too,
just search-and-replace `filipegarcia.gitlab.io/claudius` once.

## The contract

The page tells visitors to run:

```sh
curl -fsSL <siteUrl>/setup.sh | bash
```

So whichever host you pick has to serve `setup.sh` at that path. GitLab
Pages does this out of the box — drop `setup.sh` into the published
directory and the URL just works. `bash` doesn't care about the
`Content-Type` (GitLab Pages serves `.sh` as `application/octet-stream`,
which curl-pipe-bash handles fine).

## Deploy to GitLab Pages

GitLab Pages publishes whatever a CI job stages into `public/`. Add a
`pages` job to `.gitlab-ci.yml` (at the repo root) that copies
`marketing/` into `public/`:

```yaml
pages:
  stage: deploy
  image: alpine:latest
  script:
    - mkdir -p public
    - cp -r marketing/* public/
  artifacts:
    paths:
      - public
  rules:
    # Only build Pages from the default branch. PRs / MRs don't publish.
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  pages: true   # required since GitLab 17.x — opts the job in to Pages
```

After the job succeeds the site is live at
`https://<group-or-user>.gitlab.io/<project>/`. For `filipegarcia/claudius`
that's `https://filipegarcia.gitlab.io/claudius/`.

### Custom domain

Settings → Pages → Domains → "New domain". Add a `CNAME` for your domain
pointing at `<group>.gitlab.io`, then update `config.js` to your custom
domain. Lock down to HTTPS in the same Pages settings.

## Local preview

```sh
cd marketing
python3 -m http.server 8000
# open http://localhost:8000
```

Or any equivalent (`npx serve .`, `caddy file-server`, etc.).

## Updating the script

`setup.sh` is the spec. Edit it, push, the next Pages run publishes it.
There is no build artifact and no template — the file you serve is the
file that runs. When you change the marketed URL, keep `setup.sh`'s
header `Usage:` block in sync so `curl … | bash --help` prints the same
canonical command shown on the landing page.
