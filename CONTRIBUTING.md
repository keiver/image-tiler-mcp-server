# Contributing

This tool is actively maintained by its author, who uses it daily. That means bugs get fixed, features get real-world testing, and the project moves forward with purpose, not just PRs.

You are welcome to contribute. Here is how to do it well.

---

## What is worth contributing

**Bug reports:** If something breaks, open an issue. Include your OS, Node version, the MCP client you are using, and a minimal reproduction. The more specific, the faster it gets fixed.

**Bug fixes:** If you found it, you are welcome to fix it. Open an issue first so we can agree on the root cause before you write code.

**New model configs:** Vision model pipelines change. If a model's tile size, token rate, or max dimension is wrong or missing, that is a high-value contribution. Check `src/constants.ts`.

**Chrome / CDP edge cases:** URL capture is the most environment-sensitive part of this project. Real-world failures from different Chrome versions, OS setups, or page types are valuable.

**Performance findings:** Sharp memory behavior, tile extraction order, concurrency limits. If you measured something, share it.

---

## What is not worth contributing (right now)

- New transport layers (HTTP, SSE): stdio is intentional for now
- Abstract plugin systems or "model provider" interfaces: over-engineering for the current scope
- Cosmetic refactors without functional change
- Features you want but have not tested yourself

If you are unsure whether something fits, open an issue and ask before writing code.

---

## How to submit a change

1. Fork the repo and create a branch off `main`
2. Run the test suite: `npm test`
3. Add or update tests for whatever you changed
4. Keep the diff focused, one thing per PR
5. Open the PR with a clear description of what changed and why

There is no CLA. MIT license applies to all contributions.

---

## Development setup

```bash
npm install
npm run build     # compile TypeScript
npm test          # run all tests (vitest)
npm run dev       # watch mode
npm run inspect   # MCP Inspector for interactive testing
```

Test images live in `assets/`. Do not delete them, integration tests use them.

See `CLAUDE.md` for full architecture notes.

---

## Honest expectations

This is a small project. Reviews may take a few days. Not every idea will be accepted. If your PR sits too long without response, ping in the issue thread.

The goal is a sharp, well-maintained tool, not a large one.
