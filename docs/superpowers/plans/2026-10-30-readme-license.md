# README and License (Task 11h) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new reader understands what the project does, how to set it up and how to work on it,
without the task history.

**Architecture:** documentation only.
- `LICENSE`: MIT, `Copyright (c) 2026 alexandersokol`.
- `README.md`: rewritten in English, in the spec's section order.
- `companion/README.md`: short developer notes, linking back to the root README.

**Tech Stack:** Markdown, GitHub-flavoured Mermaid.

Spec: [2026-10-30-ci-release-readme-design.md](../specs/2026-10-30-ci-release-readme-design.md),
section 4. Task: implementation-plan.md, 11h.

## Global Constraints

- Sections in the spec's order: title and badges, what it does, how it works, privacy, setup for
  owners, using the bot, development, contributing, security, license, acknowledgements.
- Badges point at `ci.yml` and the releases page of `alexandersokol/aw-telegram`; link to the
  releases page, never a specific release.
- Every command matches `docs/setup.md`, `docs/operations.md`, `bot/package.json` and
  `companion/` tooling. Every relative link resolves. No images.
- No task-progress text: it stays in `implementation-plan.md`. Cloud hardening (11i) is not
  described as done.
- `python tools/licenses.py check` keeps passing with `LICENSE` at the root.

## Tasks

- [ ] Add `LICENSE`; run `tools/licenses.py check`.
- [ ] Rewrite `README.md`; draw the Mermaid diagram with quoted labels only.
- [ ] Replace `companion/README.md` with developer notes.
- [ ] Check every relative link and anchor, and every command against the sources above.
- [ ] Record 11h as done in `docs/implementation-plan.md`.
