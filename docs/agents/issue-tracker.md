# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- Create an issue with `gh issue create --title "..." --body-file <file>`.
- Read an issue and its discussion with `gh issue view <number> --comments`.
- Apply or remove labels with `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close completed work with `gh issue close <number> --comment "..."`.
- Infer the repository from the current clone and its `origin` remote.

## Pull requests as a triage surface

PRs as a request surface: no.

## Publishing work

When a skill says to publish a spec or ticket, create one GitHub issue. Use native GitHub issue dependencies when available; otherwise include a `Blocked by` section with issue references.
