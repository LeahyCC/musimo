# Set up Musimo with an LLM

Copy the prompt below into an assistant that can browse the web and run commands on the computer that will host Musimo. A chat-only assistant can guide you through the same steps. Leave anything you do not know blank.

The prompt asks the assistant to inspect the machine, use the current repository, and verify a working installation. Navidrome and remote access are optional. It does not assume someone else's folder paths, accounts or Docker setup.

## Copy this prompt

```text
Help me install and fully set up Musimo on my computer or server.

Repository: https://github.com/LeahyCC/musimo

My details, if known:
- Computer/server and operating system:
- Existing music folder(s):
- Folder where new downloads should go:
- Existing Navidrome server, or whether I want one installed:
- Access needed: this computer only, home network, or remotely through Tailscale:
- Existing Musimo or another music app to migrate from:

Take the installation through to verified use. Run commands and make the necessary local configuration changes if your tools allow it. If you cannot access the host, give me a few exact commands at a time for my shell and wait for their results. Never imply you ran something you only described.

Keep explanations short and use plain words. Discover what you can before asking questions. Ask only for missing choices, login steps or access you actually need. Use local-only access, original audio format and the existing queue defaults unless I choose otherwise. A music folder is my choice: if it is unknown, use an isolated test folder while asking where the real collection belongs.

1. Inspect the host and current project.

Check the OS, CPU architecture, available disk space, Git, Docker, Compose, occupied ports, and existing app containers and volumes. Confirm the Docker daemon runs Linux containers. Reuse an existing Musimo checkout and deployment when present; inspect its revision, local changes, Compose project name and attached data volume before updating anything.

For a new installation, clone the repository. Read README.md, compose.yaml, Dockerfile, .env.example, docs/settings.md, docs/downloads.md, docs/reverse-proxy.md and docs/youtube-troubleshooting.md. Check current code when documentation disagrees. Treat the original brief and roadmap as plans, not proof of working features. Record the revision being installed. Do not assume a published Musimo image exists: the documented Compose setup builds locally.

Install missing prerequisites using current official instructions for this OS. Docker supplies the app's Python, Node-built frontend, FFmpeg, Deno and other worker tools; do not install a second host toolchain just to run the app. Handle administrator approval, account sign-in and any required reboot with me. If this architecture cannot build or run the image, report the exact blocker instead of claiming support.

2. Configure storage without disturbing my collection.

Verify all host paths, including Windows drive letters. Preserve existing music, application state, overrides and credentials. Do not delete an old app, remove volumes, reset a database, prune Docker resources or recursively change music-folder permissions as an installation shortcut. Migration cleanup is a separate decision after the replacement works.

Use an ignored compose.override.yaml with long-form bind mounts for this machine. Map my selected writable download folder to /music, replacing the default ./runtime/music test bind. Mount additional collections read-only unless I need them writable. List the container roots in MUSIMO_LIBRARY_ROOTS, separated by colons inside the Linux container. Settings uses these container paths, not host paths. Check the merged Compose configuration before starting; do not publish its private values.

Retain /data on the local musimo-data named volume. Record the actual Docker volume name, which can include a project prefix. On Linux, choose non-root PUID/PGID values with access to the folders. Use polling for Docker Desktop Windows or music shares without reliable filesystem events. Check read access and perform a small temporary write as the app's runtime user in the chosen destination, removing only that test file afterward.

Set editable preferences through Settings or the documented API. MUSIMO_ environment values for application settings seed and lock database rows on first creation; changing or removing those variables later does not unlock them. Do not lock ordinary preferences unnecessarily.

3. Start Musimo and configure the requested integrations.

For the normal download setup, the current command is:
docker compose --profile youtube up -d --build --wait

Keep the matching pinned helper/plugin versions from the repository. The helper needs no published host port. Use the same Compose project, files and enabled profiles for later updates.

The default address is http://127.0.0.1:8765. Keep the loopback bind initially. If the port is occupied, choose a free host port in .env and use it consistently. Check docker compose ps, recent service logs, /api/health and Diagnostics. A healthy container does not prove catalog access or downloads work.

Save my destination and format. Scan the mounted collection and wait for completion. Navidrome is separate and is not included in this Compose stack. If I want it, reuse my existing installation or install it from its current official instructions. Both apps must see the same host music folder. Choose watcher mode when its watcher works, or configure API scanning using the documented library ID and a credentials file mounted read-only from outside the checkout. Keep passwords out of chat, logs and Git. Verify connectivity from inside Musimo: localhost there refers to the container itself.

4. Set up remote access only if requested.

Musimo currently has no built-in login. For Tailscale access, keep Musimo on loopback and configure private Tailscale Serve on the host. Check current official Serve documentation and installed CLI help. Inspect existing Serve/Funnel configuration first; preserve other apps' routes. Use an available HTTPS listener serving Musimo at its root, unless the current app explicitly supports a subpath. Do not enable public Funnel or router port forwarding for a private setup.

Check who the tailnet access rules allow to reach this service; those users can control the app. Preserve the public host and scheme through the proxy. Configure only the actual trusted proxy address if forwarded-header trust is needed. Follow docs/reverse-proxy.md for live event streaming. Do not disable same-origin protection or trust every proxy to make requests pass.

Test through the final HTTPS address, including saving a setting and live queue updates. Have me open it from a second Tailscale device if you cannot test that yourself. Record remote access as unverified until that check succeeds. For another network setup, establish its access controls before broadening the bind address.

5. Verify the complete user journey.

- Open search, find an artist, open an album and play an available preview.
- Confirm an existing known file is indexed and gets the expected library badge, if I have a collection.
- Download one recording I have permission to obtain. Use my selected example or a verified permitted fixture. Confirm the job finishes, the full audio file plays, its tags are sensible, and it exists in the intended host folder. Report missing optional artwork or lyrics honestly. A preview clip or a queued job is not a successful full download.
- Confirm the new file is indexed in Musimo and, if configured, appears and plays in Navidrome.
- Open Download all albums on an artist. Check selection and album/song counts without submitting an entire discography just to test installation.
- Once the test job has finished, restart only this Musimo service. Confirm health, saved preferences, library index and history survive, and the page reconnects to live updates.
- Check the host's Docker/service startup arrangement. Explain any login or sleep dependency that prevents unattended availability. Do not reboot the host without arranging it with me.

Use an isolated instance for repository tests that seed jobs, change settings or restart containers. Never aim them at my real library. If a provider refuses a request, inspect the job error and use the troubleshooting guide. Do not bypass restrictions or repeatedly retry a blocked source. Clearly separate an external provider failure from an installation failure, and leave that acceptance check open.

6. Leave a usable handoff.

Write a short private setup note outside tracked source, such as runtime/setup-notes.md, with the installed revision, checkout path, exact Compose project/files/profiles, URLs, host-to-container music mappings, actual data volume, selected integrations and tested results. Include start, stop, logs and update commands for this installation, plus a backup/restore procedure. Backups must cover application state, music and private configuration. Stop Musimo for a consistent database copy or use SQLite's backup API; do not copy only a live database file while ignoring its WAL. Never use docker compose down -v as an update step.

Finish with my working URL, where music and state are stored, what passed, and any remaining action. Call the requested setup complete only when its checks pass. If a login, device test or provider issue blocks completion, say exactly what is still needed and keep the completed work intact.
```

The repository files are the setup reference. For prerequisite installation and remote access, use the current [Docker Compose installation guide](https://docs.docker.com/compose/install/) and [Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve).
