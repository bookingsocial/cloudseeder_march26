# Planning Folder — CloudSeeder Architecture

**Review Date:** 2026-03-12
**Reviewer:** Senior Node.js Architect
**Codebase:** CloudSeeder v1.0.0 — Salesforce metadata-driven data loader

This folder is the persistent record of all architectural work on CloudSeeder.
It is the single source of truth for known problems, approved recommendations,
the target design, and the migration plan. Update it when findings change status,
new problems are discovered, or decisions are revised.

---

## Files in This Folder

| File | Purpose |
|---|---|
| [README.md](README.md) | This index |
| [architecture-findings.md](architecture-findings.md) | Every diagnosed architectural problem, with severity, priority, and status |
| [recommendations.md](recommendations.md) | Improvement recommendations linked 1-to-1 with findings |
| [target-architecture.md](target-architecture.md) | Ideal end-state design: folder structure, module map, layer diagram, patterns |
| [migration-roadmap.md](migration-roadmap.md) | Sequenced step-by-step plan to reach the target state safely |
| [decisions.md](decisions.md) | Architectural Decision Record (ADR) log — running log of significant choices |
| [improvementplan_20260312_0156.md](improvementplan_20260312_0156.md) | Original full review document (source of truth for all findings above) |

---

## Current Status Summary

| Metric | Count |
|---|---|
| Total findings | 18 |
| **High** severity | 5 (ARCH-001 – ARCH-005) |
| **Medium** severity | 7 (ARCH-006 – ARCH-012) |
| **Low** severity | 6 (ARCH-013 – ARCH-018) |
| **P1** (do now) | 6 |
| **P2** (next sprint) | 7 |
| **P3** (backlog) | 5 |
| Open | 18 |
| In Progress | 0 |
| Resolved | 0 |

---

## How to Use These Files

1. **Starting a fix:** Change the finding's `Status` from `Open` → `In Progress` in
   [architecture-findings.md](architecture-findings.md) and its linked recommendation
   in [recommendations.md](recommendations.md).

2. **Completing a fix:** Change both statuses to `Resolved` and add a note with the
   commit SHA or PR number.

3. **Making an architectural decision:** Add a new `ADR-NNN` entry to
   [decisions.md](decisions.md) before starting the work.

4. **Discovering a new problem:** Add a new `ARCH-NNN` entry to
   [architecture-findings.md](architecture-findings.md), a corresponding `REC-NNN`
   to [recommendations.md](recommendations.md), and a task to the relevant migration
   step in [migration-roadmap.md](migration-roadmap.md).

5. **Work order:** Tackle findings in priority order — P1 first, then P2, then P3.
   Within the same priority, prefer Small effort over Medium/Large.
