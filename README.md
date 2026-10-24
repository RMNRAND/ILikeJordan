# I Like Jordan

An invitation-only React lobby. Static files are served by Cloudflare Worker Assets; auth and lobby signaling are Worker routes. Turn events still travel over direct WebRTC data channels.

## Authentication

Sign-in emails a one-time code through Resend to an approved carrier email-to-SMS gateway address. Carrier gateways are not a reliable or universal SMS service; delivery depends on the carrier and must be verified with each recipient.

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

`RESEND_FROM_EMAIL` is configured in `wrangler.toml` as `I Like Jordan <login@ilikejordan.com>`. `ALLOWED_GATEWAY_EMAILS` is a JSON array of complete, lower-case gateway addresses, for example `["15551234567@vtext.com"]` (replace it with the actual approved gateway addresses). Generate independent random values for `AUTH_PEPPER` and `AUTH_ADMIN_KEY`; do not reuse the Resend key.

The Worker stores only keyed hashes of gateway addresses and verification codes. Codes expire after five minutes. Three incorrect codes permanently lock that address until manually reset. Delivery is limited to three codes/hour per address with a 60-second cooldown; IP limits also apply.

To manually unlock an address after configuring the `AUTH_ADMIN_KEY` secret, send the request from a trusted shell. Keep the key in a local shell variable; do not commit it:

```sh
curl -X POST https://ilikejordan.com/api/admin/unlock \
  -H "Origin: https://ilikejordan.com" \
  -H "Authorization: Bearer $AUTH_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  --data '{"address":"15551234567@vtext.com"}'
```

## Deploy

Run `npm ci`, `npm run build`, then `npx wrangler deploy` after setting the Worker secrets. The GitHub Pages publish workflow is removed because static Pages cannot enforce this Worker gate. Disable the existing Pages site after the Worker is live on `ilikejordan.com` so the old Pages URL is not an alternate public app.

For automatic Worker deployments, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions repository secrets. The token needs permission to edit Workers and read the account. Without those CI secrets, the workflow safely skips deployment.

## Limits and privacy

The Worker is configured for the Cloudflare free tier and uses origin-scoped routes, request-size caps, per-IP limits, and allowlist-only email sending. This does not guarantee protection from DDoS or prevent service limits from being exhausted. Verify current Cloudflare and Resend quotas and billing settings. Robots metadata asks compliant crawlers not to index the site; it is not an access-control mechanism.

WebRTC uses a public STUN server and does not use a TURN relay. Some network pairs may fail to connect, and peers may learn each other's public IP addresses.