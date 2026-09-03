# Working agreement

How Arundhati and Junaid work on whyrouted. This is the project-wide agreement —
it holds for every milestone unless a milestone's own task-split doc explicitly
overrides a point for that milestone.

It applies to **code and implementation work.** Planning and design docs
(milestone task splits, idea docs, this file) land directly on `main` — they're
not code to review.

**All code lands through a pull request. No direct code commits to `main`.**

## Branches

- One branch per task (or per small group of related tasks), named plainly:
  `junaid/replica-server`, `arundhati/service-registry`, `joint/main-wiring`.
- Keep branches short-lived. Open the PR early as a draft if it helps.

## Commits

- **Lots of small commits.** Each commit is one coherent step that builds and,
  where it makes sense, passes tests. If you can't describe a commit in one short
  line, it's doing too much — split it.
- **Plain English commit messages. No `feat:` / `fix:` / `chore:` prefixes, no
  scopes, no conventional-commits.** Just say what the commit does, lowercase,
  imperative or plain past — whatever reads naturally.
  - Good: `add the health endpoint to the simulated replica`
  - Good: `make the scheduler mark a replica unhealthy after 3 misses`
  - Good: `pull the port range into config`
  - Avoid: `feat(replica): implement health endpoint`
- Body is optional — add a line or two only when the "why" isn't obvious from
  the change.
- **No AI co-author trailers.** Commits are attributed to us only. If any tool
  (Claude Code, Copilot, etc.) appends `Co-Authored-By:` or a session/trace
  line, strip it before the commit lands. Applies to every branch and to the
  planning docs on `main`.
- **No task IDs in commit messages.** `J6`, `B4`, `A1–A3` and the like are
  planning shorthand for the milestone task-split docs only — they mean nothing
  in the git history once a milestone is closed. Say what the change does in
  plain words.

## Pull requests

The commits are casual; **the PR description is where the real explanation goes**,
because that's what the other person reviews against.

**PR titles and descriptions use plain words, not task IDs** — no `J6` / `B4` /
`A1–A3` in the title or the body. The mapping to a milestone's tasks lives in
that milestone's task-split doc, not in GitHub. Every PR includes:

1. **What this does** — one paragraph, plain English.
2. **Why** — what part of the system this is, in plain words, and how it fits.
3. **How it works** — the key design choices a reviewer needs to follow the code:
   module boundaries, data shapes, anything non-obvious. Call out anything that
   touches a shared interface.
4. **How to test it** — exact commands the reviewer runs, plus what they should
   see. Include the manual demo steps if there are any.
5. **What's not covered** — known gaps, follow-ups, things deferred to later.
6. **Review focus** — where you specifically want the reviewer to look hard.

Keep PRs small enough to review properly in one sitting — roughly one task group
per PR, not a whole track in one go.

## Review

- **The other person reviews every PR.** Junaid reviews Arundhati's, Arundhati
  reviews Junaid's. Joint PRs: whoever wrote less of it reviews.
- Review means actually reading the code and running the "how to test it" steps —
  not a rubber-stamp approve.
- Leave line comments. Ask questions freely. Request changes if something's off.
- Approve only when you'd be comfortable owning the code.
- Author merges after approval. Squash only if the commit history is messy;
  otherwise keep the small commits — they're part of the contribution record.
- Both people should end each milestone having authored a comparable number of
  PRs and reviewed a comparable number. Track it loosely; rebalance if it drifts.

## Milestone boundaries

- Each milestone starts with a task-split doc under `docs/milestones/mN/` and
  ends with an architecture review under `docs/architecture/mN.md`, signed off by
  both people before the next milestone's planning begins.
- Load-bearing technical decisions get recorded in `docs/decisions.md` as they're
  made.
