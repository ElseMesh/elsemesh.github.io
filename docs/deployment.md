# Client deployment and domain

The repository moved on 2026-10-02 to https://github.com/ElseMesh/elsemesh.
Local `origin` and `main` tracking now point there; `upstream` retains the original
Tidewater repository. The `rebroad` remote is a compatibility alias for the new
repository. Source/build directory names remain unchanged. Archived LOZ branches
were retained by the transfer.

## GitHub Pages

Client: https://elsemesh.github.io/
Archived LOZ client: https://elsemesh.github.io/loz/

`.github/workflows/deploy.yml` deploys every push to `main`, including the LOZ
archive. Check Actions for success and compare the client bottom-right eight-digit
stamp with the source HEAD. GitHub repository URL redirects do not guarantee
redirects for old `rebroad.github.io/tidewater/` links; use the new address.

On 2026-10-10, Pages run `38058831316` successfully built and deployed main at
`c2822f60206698010b01f4d503d2f91213e3536f` and the preserved
`archive/loz/main` ref at `f691cd9`. The archive includes the imported `loz/main`
history and its later arrow-key look-controls change; its build also passed
`test/input-look-keys.mjs`. After deployment, both `/` and `/loz/` returned
HTTP 200 and referenced their respective JavaScript bundles.

## Selected ThruHolds

The static client accepts `worldId`, `nodeId`, `gateway` and `directory` query
arguments. For example (replace the placeholder with an actual world gateway):

```text
https://elsemesh.github.io/?worldId=tw-world%3Aexample-island&gateway=https%3A%2F%2Fworld-host.example
```

Pages hosts the renderer, not `worldd` or discovery. A hosted-world invite needs a
reachable HTTPS/WSS gateway with the appropriate browser origin configuration.
The development backends on loopback port 5200 are not accessible from a phone
or from an HTTPS Pages client. Use the local links in
[Testing two worlds](testing-two-worlds.md) for development.
`?example=1` explicitly selects the complete offline procedural island.
Use **Share world invite** in the World panel to construct a hosted invite.
Browser home/visit preferences are origin-local and do not transfer from the old
Pages origin to the new one or to the custom domain.

## elsemesh.org

DNS inspection on 2026-10-02 found Namecheap nameservers, an apex parking address
`162.255.119.79` and `www` pointing to `parkingpage.namecheap.com`. The domain is
not yet connected to Pages. Preserve unrelated DNS records, including email.

1. Verify the domain for the **ElseMesh organisation** in GitHub Pages settings
   using the organisation-provided TXT verification record.
2. Set the repository Pages custom domain to `elsemesh.org` (Actions deployments
   use the Pages setting; adding a tracked CNAME file is not required).
3. Replace apex parking/URL-redirection records with these four A records for `@`:
   `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`.
4. Replace the `www` parking CNAME with `elsemesh.github.io`.
5. Wait for DNS validation and certificate provisioning, then enforce HTTPS and
   verify https://elsemesh.org/ plus a selected-world invite. The same query
   arguments work at the domain root.

Do not switch the live Pages custom-domain setting before DNS access is ready:
it redirects the working GitHub.io address to the custom domain.

Reference: [GitHub custom-domain documentation](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
