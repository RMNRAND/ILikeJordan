# I Like Jordan

An invitation-only React lobby. Static files are served by Cloudflare Worker Assets; auth and lobby signaling are Worker routes. Turn events still travel over direct WebRTC data channels.

## Authentication

Sign-in emails a one-time code through Resend to an approved regular email address.

Before enabling the Worker:

1. Verify `ilikejordan.com` as a sending domain in Resend and publish its required DNS records.
2. Confirm `login@ilikejordan.com` is an approved sender.
3. Add these as Worker secrets using Wrangler. Wrangler prompts for each value; enter secrets directly in the terminal, never in chat or source control:

```sh
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put ALLOWED_GATEWAY_EMAILS
npx wrangler secret put AUTH_PEPPER
npx wrangler secret put AUTH_ADMIN_KEY
```

`RESEND_FROM_EMAIL` is configured in `wrangler.toml` as `I Like Jordan <login@ilikejordan.com>`. For compatibility, the secret is still named `ALLOWED_GATEWAY_EMAILS`, but its value should now be a JSON array of approved regular email addresses, for example `["player@example.com","friend@example.net"]`. Replace the list by running `npx wrangler secret put ALLOWED_GATEWAY_EMAILS` and entering the JSON array at the prompt. Generate independent random values for `AUTH_PEPPER` and `AUTH_ADMIN_KEY`; do not reuse the Resend key.

The Worker stores only keyed hashes of approved email addresses and verification codes. Codes expire after five minutes. Three incorrect codes permanently lock that address until manually reset. Delivery is limited to three codes/hour per address with a 60-second cooldown; IP limits also apply.

To manually unlock an address after configuring the `AUTH_ADMIN_KEY` secret, send the request from a trusted shell. Keep the key in a local shell variable; do not commit it:

```sh
curl -X POST https://ilikejordan.com/api/admin/unlock \
  -H "Origin: https://ilikejordan.com" \
  -H "Authorization: Bearer $AUTH_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  --data '{"address":"player@example.com"}'
```

## Deploy

Run `npm ci`, `npm run build`, then `npx wrangler deploy` after setting the Worker secrets. The GitHub Pages publish workflow is removed because static Pages cannot enforce this Worker gate. Disable the existing Pages site after the Worker is live on `ilikejordan.com` so the old Pages URL is not an alternate public app.

The `Deploy I Like Jordan` workflow builds and deploys on every push to `main`. To enable it, add one GitHub Actions repository secret named `CLOUDFLARE_API_TOKEN` under **Settings → Secrets and variables → Actions**. Create a scoped Cloudflare token with permission to edit Workers Scripts and the account resources needed by this Worker (Durable Objects and R2); do not paste the token into chat or commit it. The account ID is already configured in `wrangler.toml`. Until `CLOUDFLARE_API_TOKEN` is added, pushes will build but the deploy job will fail with a setup message rather than silently skipping.

## Limits and privacy

The Worker is configured for the Cloudflare free tier and uses origin-scoped routes, request-size caps, per-IP limits, and allowlist-only email sending. This does not guarantee protection from DDoS or prevent service limits from being exhausted. Verify current Cloudflare and Resend quotas and billing settings. Robots metadata asks compliant crawlers not to index the site; it is not an access-control mechanism.

WebRTC uses a public STUN server and does not use a TURN relay. Some network pairs may fail to connect, and peers may learn each other's public IP addresses.