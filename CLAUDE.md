# ชงสุดใจ — notes for Claude

- **Every change that reaches users bumps the version** in `version.js` (`APP_VERSION`, semver: new feature = minor, fix = patch)
  and sets `APP_UPDATED` to the date. The settings page shows it, and `sw.js` names its cache after it so devices pick up new files.
- Backend for LINE OA is the Cloudflare Worker in `worker/` (`npm test`, `npx wrangler deploy`). Secrets live in Cloudflare, never in the repo (it is public).
- UI text is Thai.
