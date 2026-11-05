# cc-cockpit marketplace

The index of plugins the [cc-cockpit](https://github.com/BronOS/cc-cockpit) app shows in its Marketplace tab.
The app fetches one static file, `index.json`, from this repo. There is no server.

## What "listed" means

Listed means the entry is well formed and that its tag, commit, id, version and api match the plugin's repo at
the time of listing. **It does not mean anyone reviewed the code.** A plugin runs with full access to your
computer, so install one only if you trust its author.

What the index does give you:

- it pins the exact commit, and the app refuses to install a tag that has moved;
- it can revoke a known-bad commit (see below).

## List a plugin

1. In your plugin's repo: commit the built `main` file (nothing is compiled on install), then tag the commit.
2. Open a PR here adding `plugins/<id>.json`, named after the plugin id:

   ```json
   {
     "id": "you.example",
     "name": "Example",
     "description": "What it does, in a sentence.",
     "author": "Your Name",
     "repo": "https://github.com/you/cockpit-example.git",
     "version": "1.0.0",
     "tag": "v1.0.0",
     "commit": "<the full 40-character commit the tag points at>",
     "api": 1,
     "category": "developer",
     "owners": [12345678]
   }
   ```

   `owners` holds the numeric GitHub user ids allowed to publish new versions (`gh api users/<login> --jq .id`).
   Numbers and not logins, because a login can be given up and registered again by somebody else. `owners` is left
   out of the published `index.json`.

The rules: `repo` is `https://` with no credentials; `commit` is the 40-character lower-case hash; `id` and `version`
are as in `plugin.json`, and an `id` starting with `cockpit.` is refused (reserved for plugins the app ships); `name` and `author` are at most 100 characters, `description` at most 1000; `category` is optional (see below); no unknown fields.

The `check` workflow clones your repo at the tag, runs nothing from it, and compares `commit` and the `id`, `version`
and `api` of `plugin.json`, checks that the `main` file exists, and checks `preview.png` (below). A person then reviews and merges a new listing.
That is not the app's full manifest validation, so an entry can pass here and still be refused at install: try it first
with Settings > Plugins > Install from git URL. A clone failure is reported without git's own text, because this log
is public and a PR picks the host; run `git clone --branch <tag> <repo>` yourself to see why.

## Preview and category

**Preview.** Put `preview.png` at the root of your repo, in the tagged commit: the app shows it on the plugin's card.

- PNG, at most 512 KiB, 1280×800 recommended (16:10); anything from 640×400 to 1600×1000 is accepted;
- a still image: an animated PNG (an `acTL` chunk) is refused;
- a regular file, not a symlink.

The `check` workflow reads only the PNG's framing (signature, size, chunk headers) and decodes nothing. A preview that
breaks a rule fails the check. A missing one passes with a warning on the PR until the date in `preview-policy.json`
(`requiredFrom`, `YYYY-MM-DD`, UTC; `null` means warnings only); from that day any PR that adds or changes an entry
whose tagged commit has no preview is refused, a fix to the description or `owners` of an older listing included.
Listings already on `main` without a preview stay listed, with a warning in every publish run.

After a merge, `publish-index.yml` clones each listing whose commit has no preview yet (in a job with no token), copies
the image to `previews/<id>/<commit>.png` next to `index.json`, and the entry in `index.json` gets
`"preview": { "sha256": "…" }`. A commit whose repo had no usable preview gets the marker `previews/<id>/<commit>.none`
instead, so it is not cloned again every hour; delete the marker to make the next run look again. A clone that fails,
or a tag that no longer points at `commit`, gets `previews/<id>/<commit>.failed` (the time of the try), and the
listing is tried again a day later. One run fetches at most 20 previews and starts no clone after 10 minutes; the rest
wait for the next run. The app fetches the image from this repo, never from yours, and checks it against that hash.

**Category.** `category` is one of `integrations`, `productivity`, `ai`, `developer`, `appearance`, `other`; leaving it out means
`other`. Any other value fails the check. The Plugins page filters by it.

## Publish a new version

Open a PR that changes `version`, `tag`, `commit` and, if needed, `api` in your entry. A new commit always needs a new
version, a fix included: the app cannot update a plugin to the version it already has, so the check refuses a new
commit under the same version. The PR merges by itself when the check is green and all of these hold; anything else
waits for a person:

- it changes exactly one file, an existing `plugins/<id>.json`, and only those four fields;
- you are in that entry's `owners` on `main`;
- the version goes up;
- the commit is not in `revoked.json`.

Changing `repo` always needs a person, and users of the plugin must uninstall and install again to follow it.

## Report a bad plugin

Open an issue naming the plugin id and the commit, and what it does. For a security problem you do not want to
describe in public, use a private vulnerability report on this repo.

A confirmed bad commit gets a row in `revoked.json`:

```json
[{ "id": "you.example", "commit": "<40-character commit>", "reason": "Why, in a sentence." }]
```

The app stops a revoked plugin at its next index fetch and tells the user why. There is no override: the user can
move to another version from the same index, or uninstall. Only this official index, or the index a plugin was
installed from, can disable it; a revocation from any other index the user added shows as a warning.

## Running this repo

Set up once:

- **Branch protection on `main`**: require a pull request and the status check `check`. Do not require approvals, or
  the machine merge is refused and every bump waits for a person (that failure is safe, only slower). Leave "Require
  branches to be up to date" off (a bump from a stale fork is refused) and keep squash merging enabled, because
  `auto-merge.yml` merges with `merge_method=squash`. Both failures are safe, only slower.
- **`PUBLISH_TOKEN` secret**: the publish step pushes `index.json` straight to `main`, which branch protection refuses
  for `GITHUB_TOKEN`. Create a fine-grained token for this repo alone with `Contents: read and write`, make its
  owner a repo admin with "Do not allow bypassing the above settings" off, or a bypass actor of a ruleset that
  protects `main` (the classic bypass list only covers "require a pull request", not the required check, which the
  `index.json` commit never has), and store it as the `PUBLISH_TOKEN` Actions secret. It is used only by
  `publish-index.yml`, never next to PR content. The first publish needs it too; until then the app shows the index as
  an error. A fine-grained token expires: after that, merges still succeed but the publish job fails and `index.json`
  and its revocations go stale. `publish-index.yml` also runs hourly, so its failures keep showing red and it catches up
  by itself once the token is renewed (or run it by hand with `workflow_dispatch`; do that after first setting the
  secret too). GitHub turns schedules off after 60 days with no repo activity, so re-enable it if it was turned off.
- **Never rename or transfer this repo.** The app has the raw URL of `index.json` built in and refuses redirects, so
  every installed copy would be left with its cached index and a fetch error, and no new revocation would reach it.
- **Private vulnerability reporting**: turn it on in the repo's security settings, for the reports above.
- **Workflow permissions**: read-only by default; each workflow asks for what it needs. Keep "require approval for
  first-time contributors" on.
- **One test bump, once the above is done**: open a real version bump from an account in the entry's `owners` and
  watch it merge and `index.json` publish. Nothing else exercises this chain, since the repo's tests only read the
  workflow files. The `merge` job has `contents: write` and `pull-requests: read`, which is what GitHub's permission
  tables list for the merge call. If the `Merge` step answers 403 "Resource not accessible by integration", set
  `pull-requests: write` on that job and try another bump. Until then every bump waits for a person and nothing is
  published by the machine merge (that failure is safe, only slower).

`auto-merge.yml` decides against one commit of `main` and re-reads `main` just before merging. If it moved (a publish
pushing `index.json` counts), the bump is left for a person, or re-run the workflow to decide again. This narrows the
window for an owner removed mid-run and does not close it, because GitHub's merge call has no condition on the base. A
bump that merges in that gap is handled by revoking its commit.

The merge itself uses `GITHUB_TOKEN`, and a merge made with that token triggers no other workflow. So `auto-merge.yml`
calls `publish-index.yml` itself, and a person's push to `main` triggers it the usual way.

An entry on `main` that does not validate does not stop the publish, or it would hold up new revocations: the entry keeps
its last published listing (or stays out, with none), `index.json` is pushed, and the run fails naming the file. Fix the
entry. A bad or missing `revoked.json` does stop it, and nothing is published until it is fixed. Such an entry does not
fail the check of a PR that leaves it as it is, so a revocation can still merge; a PR that adds or changes a bad entry fails.

`tools/dist/*.js` are built bundles, committed so CI runs them with plain `node` and no install step. Their source is
`tools/src/`, built in the cc-cockpit repo with `npm run build:marketplace-tools` (it shares the validator the app
runs). Do not edit them by hand here.

Actions use the first-party `actions/*` major tags and plain `gh` and `git`, and no third-party action.
