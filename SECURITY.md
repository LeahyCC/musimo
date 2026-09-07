# Security

## Reporting a vulnerability

Report privately to Colin Leahy at **ccleahy2020@gmail.com**, with subject `Musimo security report`. If GitHub's **Report a vulnerability** button is available on this repository's Security page, you may use that private channel instead. Do not post an exploit, credential or personal library data in a public issue.

Include the affected revision, deployment conditions, impact, minimal reproduction and any proposed fix. Use generated data. Share only what is needed to reproduce the issue. The maintainer may ask for more detail through the same private channel. No response deadline or bounty is promised.

## Supported versions

Musimo is in early development. Security fixes target the current development version; there is no maintained legacy branch or long-term support promise. Check release notes before updating a database or restoring an older image.

## Deployment boundaries

The default bind is loopback. There is no built-in login, multi-user isolation or permission model. A network client that reaches the app should be treated as having access to its operations. Same-origin write checks do not replace authentication.

Use authentication and HTTPS at a correctly configured reverse proxy before broader access. Restrict mounted folders and credentials to what the app needs. Prefer read-only mounts for reference collections. Do not mount the Docker socket, run privileged or expose unrelated host folders.

Keep the database local and backed up. Never share raw state volumes or unreviewed diagnostics. Follow provider limits and keep bundled tooling updated through reviewed builds.

## Disclosure

Maintainers will assess reports and coordinate a fix and public notice where appropriate. Please allow a reasonable opportunity to investigate before disclosing exploitable details. This policy is not a guarantee of immunity, a paid testing agreement or permission to test installations operated by someone else.
