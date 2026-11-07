# Domain and access policy

`predictir.dev` and `www.predictir.dev` serve the Vercel deployment. Cloudflare manages the domain perimeter; the app independently requires a revocable private invitation.

## Release checks

- Keep end-to-end HTTPS with certificate validation. Use Full (strict) if proxying traffic; do not use Flexible mode.
- Preserve domain verification and CAA records. Review nameserver and DNSSEC changes together to avoid invalid delegation.
- Redirect `www` to the canonical domain without copying invitation fragments into logs.
- Keep automatic attack mitigation enabled. Challenge suspicious traffic without challenging static verification files or trusted health checks indiscriminately.
- Cache fingerprinted public assets. Do not cache account responses, invitation redemption, research responses, paper scenarios or event streams.
- Preserve the app's restrictive security headers and private `no-store` policy.
- Keep analytics beacons disabled on private invitation pages and inside the private workspace.

DNS, firewall and certificate settings belong to the provider account. This folder does not claim to provision settings that have not been imported and verified. The app's access control remains effective if a request reaches the hosting origin directly.
