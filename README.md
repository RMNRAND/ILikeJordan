# I Like Jordan

A static React lobby for turn-based board games. GitHub Pages serves the app. A Cloudflare Worker assigns six-letter lobby codes, tracks players, and exchanges WebRTC connection setup messages. Turn text is sent over direct WebRTC data channels; the Worker does not relay turns.

## Local development

```sh
npm ci
cp .env.example .env.local
npm run dev
```

The deployed Worker origin is configured as the default. Set `VITE_SIGNALING_URL` only when testing against a different Worker.

## Deploy

1. Deploy the Worker with `npx wrangler login` and `npm run deploy:worker`.
2. Enable GitHub Pages with **GitHub Actions** as the build and deployment source.
3. Push to `main`; `.github/workflows/pages.yml` builds and deploys the static app.

The Worker workflow uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` GitHub Actions secrets. Add them under repository **Settings → Secrets and variables → Actions** to enable automatic Worker updates. Create a scoped Cloudflare API token with Workers Scripts edit and account read permissions; never put the token in source control or chat. Until those secrets exist, the already-deployed Worker stays live and CI skips Worker redeployment. The browser-based Wrangler login is enough for a one-time local deployment.

## Limits and privacy

Rooms admit at most six players. Lobby connections are ephemeral and are not stored as game history. The current host forwards turn events across its direct peer links; clients retain a bounded local event log and a newly elected host shares its log when links are rebuilt. A room needs at least two connected players to continue.

This configuration is intended for Cloudflare's free plan. It does not configure a paid plan or billing. Free plan quotas can still make the service unavailable when exhausted; confirm current account limits before public launch. This is not DDoS protection, and account-level limits and Cloudflare security settings should be reviewed before sharing the app broadly.

WebRTC tries a direct peer connection using a public STUN server. Some network pairs cannot connect without a TURN relay; this app does not configure one. Other participants may be able to learn a peer's public IP address.