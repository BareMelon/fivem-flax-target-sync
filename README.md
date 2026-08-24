# Cloud-synced Danish FiveM target inventory

This repository is the cloud runner for the existing FiveM webhook auditor.
Every three days it:

1. downloads the public Cfx.re directory;
2. identifies Danish FiveM listings;
3. verifies the exact, case-insensitive resource name `flaxhosting_filer` from
   each candidate's public resource list;
4. writes the current `name,endpoint` CSV;
5. replaces the complete inventory through the existing authenticated
   `PUT /api/v1/targets` management endpoint.

The auditor does not need to change. It already calls `GET /api/v1/targets` at
the start of a run, so its next invocation receives the newly replaced D1 list.

```text
GitHub Actions (every 3 days)
          |
          | scan + PUT /api/v1/targets
          v
Cloudflare Worker + D1
          |
          | GET /api/v1/targets
          v
Existing FiveM webhook auditor
```

## Why the scan does not run inside a Free Worker

Cloudflare still hosts the management API and D1 database. The scanner itself
runs on a standard GitHub-hosted Linux runner because a Workers Free scheduled
invocation is limited to 10 ms CPU and 50 external subrequests. The current
scan downloads a roughly 20 MB directory and checks hundreds of Danish server
records, so one Free Worker invocation cannot complete it reliably.

Standard GitHub-hosted Actions runners are currently free for public
repositories. This workflow runs daily for a few seconds, but the committed
`.sync-state.json` permits a real scan/replacement only after 72 hours. The
successful state commit also creates repository activity, preventing GitHub's
60-day inactivity shutdown for public scheduled workflows.

Platform policies can change in the future, so no third-party service can be
promised to be free forever. This design uses no paid feature and stays within
the current public-repository and Cloudflare Free allowances.

References:

- <https://developers.cloudflare.com/workers/platform/limits/>
- <https://developers.cloudflare.com/d1/platform/pricing/>
- <https://docs.github.com/en/actions/concepts/billing-and-usage>
- <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows>

## One-time Cloudflare update

The existing preference/inventory Worker has been updated to accept an empty
full replacement only when this additional header is present:

```http
X-Confirm-Empty-Inventory: REPLACE_WITH_EMPTY
```

This is required because the current verified result contains zero matching
servers. Without the guarded empty replacement, stale non-matching rows would
remain in D1. Normal manual uploads that accidentally contain no rows are still
rejected.

From the existing `fivem-preference-service` project, run its tests and deploy
the updated Worker once:

```powershell
npm install
npm run check
npx wrangler deploy
```

Do not create a new D1 database. Keep the existing `database_id`,
`ADMIN_API_KEY`, and `AUDITOR_API_KEY`, so the current auditor remains attached
to the same service and data.

## Put this runner on GitHub

1. Create a public GitHub repository and copy this folder's contents to its
   root. The `.github/workflows/sync-flax-targets.yml` file must remain in that
   exact location.
2. In **Settings > Secrets and variables > Actions**, add these repository
   secrets:

   - `FIVEM_AUDITOR_SERVICE_URL` — for example,
     `https://YOUR-WORKER.workers.dev`
   - `FIVEM_AUDITOR_ADMIN_KEY` — the existing Worker's admin key

3. In **Settings > Actions > General > Workflow permissions**, allow workflows
   to read and write repository contents. The workflow needs this only to
   commit the last successful sync timestamp.
4. Open **Actions > Sync flaxhosting_filer FiveM targets** and choose
   **Run workflow** once. Manual runs ignore the 72-hour timer.

The secrets are sent only to the Cloudflare management endpoint. They are not
stored in the CSV, committed state, or logs. The workflow has no pull-request
trigger and pins the two official GitHub actions to exact commits.

## Replacement safeguards

- Resource matching is exact and case-insensitive.
- If any Danish candidate's resource list remains unverifiable after retries,
  the scanner fails and the D1 inventory is not changed.
- The management request is a complete replacement, so missing old servers are
  removed and newly matching servers are added in the same transaction.
- A zero-row result is accepted only when both the runner's explicit
  `ALLOW_EMPTY_TARGETS=true` setting and the Worker's empty-inventory safety
  header are present.
- The runner verifies the Worker's returned count before recording success.
- Concurrent sync runs are disabled.

## Local test or manual scan

Local execution is optional and is not the production schedule:

```powershell
npm install
npm test
npm run scan -- --resource flaxhosting_filer --output targets.csv
```

For all scanner options, use `npm run scan -- --help`.

The older PowerShell scripts remain available for a one-off manual recovery,
but the local Codex schedule is intentionally paused. Production scheduling is
owned by GitHub Actions.
