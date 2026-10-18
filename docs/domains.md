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

To move a domain from another host, such as a Worker's custom domain, add the `TXT` record first,
then replace the old record with the `CNAME` right away. While the name has no record, resolvers
that ask for it cache the empty answer for the zone's negative-cache time (the SOA minimum, 1800
seconds on Cloudflare), and keep saying that the name does not exist after Convex has verified it.
Cloudflare's own resolver forgets it at [1.1.1.1/purge-cache](https://one.one.one.one/purge-cache/).

An apex domain works through Cloudflare's CNAME flattening: [chessmerge.com](https://chessmerge.com)
is served this way.
