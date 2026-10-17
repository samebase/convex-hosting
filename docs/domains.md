# Your own domain

A custom domain needs the Convex Pro plan. Add it to the deployment in the dashboard, under
Deployment Settings, Custom Domains, with "HTTP Actions" as the destination, or with the management
API: `POST https://api.convex.dev/v1/deployments/<deployment>/create_custom_domain` with
`{"domain": "<domain>", "requestDestination": "convexSite"}`.

Then create the two records that the dashboard shows: a `CNAME` from the domain to `convex.domains`,
and a `TXT` record at `_convex_domains.<domain>` whose value is the deployment's name. On
Cloudflare, make the `CNAME` DNS only; Convex documents a proxied record as an
[advanced setup](https://docs.convex.dev/production/abuse-protection). Verification can take up to
30 minutes.

Do not choose the domain under "Override Environment Variables". That changes `CONVEX_SITE_URL`
everywhere in the app, and Convex Auth uses it as the token issuer and in its redirect URLs.

An apex domain, such as `example.com`, relies on Cloudflare's CNAME flattening and is not tested
yet.
