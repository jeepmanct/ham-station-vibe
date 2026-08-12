# Contributing

Thanks for considering a contribution. A few things to know before opening a PR.

## License and sign-off

This project is licensed under [AGPL-3.0](LICENSE). By contributing, you agree
your contribution is licensed under the same terms.

Every commit must be signed off, certifying you wrote it (or otherwise have
the right to submit it) under the
[Developer Certificate of Origin](#developer-certificate-of-origin):

```sh
git commit -s -m "Your commit message"
```

That appends a `Signed-off-by: Your Name <you@example.com>` line using your
git `user.name`/`user.email`. PRs with unsigned commits won't be merged —
add the sign-off (`git commit --amend -s`, or `git rebase --exec 'git commit --amend --no-edit -s' <base>`
for multiple commits) and force-push.

## Development setup

```sh
# API (http://localhost:3000)
cd api
bun install
bun scripts/set-password.ts "your-admin-password"   # first time only
bun run dev

# Frontend (http://localhost:4321), in another shell
cd web
bun install
bun run dev
```

See `setup.sh` for the guided install path (systemd services, Caddy) used on
a real deployment — not needed for local development.

## Code style

- TypeScript everywhere, both `api/` and `web/`.
- No comments unless they explain a non-obvious *why* — a hidden constraint,
  a workaround for a specific upstream bug, a subtle invariant. If a comment
  just restates what the code does, leave it out.
- No speculative abstraction. Solve the problem in front of you; don't build
  a generic layer for a second use case that doesn't exist yet.
- Match the surrounding file's conventions before introducing new ones.

## Pull requests

- Keep PRs focused — one feature or fix per PR is easier to review than a
  bundle of unrelated changes.
- Test locally against a real (or test) admin login and, where relevant, a
  real data source — several bugs in this codebase's history were only
  caught by hitting the real upstream API/HTTP route rather than a mocked
  or standalone test, so prefer that when it's practical.
- Describe *why* the change is needed, not just what it does — the diff
  already shows what changed.

## Developer Certificate of Origin

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
