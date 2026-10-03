# slvm

**S**cratch **L**evel **V**irtual **M**achine: intermediate representation and optimization infrastructure for [Scratchpiler](https://github.com/Scratchpiler/scratchpiler).

It's a parody of [LLVM](https://llvm.org/). LLVM gives C, Rust and Swift a shared IR and a pile of optimization passes before they hit real hardware. SLVM gives a text DSL for a children's block-coding website the same treatment before it hits a JSON blob of colored puzzle pieces. We are aware of the proportions. We're doing it anyway.

> **Status: draft 4.** There is a miniature IR with a text form, a verifier, `constfold`/`dce`, the full legalization pipeline (`-p legalize`), `slc` (blocks that run correctly in the real scratch-vm), two CLIs (`slopt`, `slc`) and a reference interpreter. Scratchpiler has an **opt-in SLVM backend** (Settings → Compiler) with irgen on its side. It compiles the whole language, including pointers, and on 10,400 randomly generated programs it matched an independent reference interpreter every time (the classic backend was wrong on 253). The IR is specified in [docs/ir.md](docs/ir.md), and planned optimizations are in [docs/optimizations.md](docs/optimizations.md). Anything marked *planned* there, or listed under [Planned](#planned) below, is intent rather than shipped behavior.

---

## Why

Scratchpiler currently compiles in one pass: source → tokens → AST → Scratch blocks (`src/compiler.js`), with a desugaring step in `src/lower.js`. That works, but every optimization or lowering trick has to be welded straight into a ~2,000-line `compile()` function, where it lives next to code that emits opcodes.

Scratch is also a strange target. There are no registers and no stack. Variables are global-ish name lookups, "functions" are custom blocks with their own screen-refresh semantics, and the cost model is *blocks executed per frame*, not cycles. That is exactly the kind of target where a proper IR with explicit passes pays off.

SLVM exists to sit between the frontend and the block emitter:

```
 .sdsl source
     │
     ▼
 Scratchpiler frontend   tokenize → parse → typecheck → lint
     │   AST
     ▼
 lowering                AST → SLVM IR
     │   IR
     ▼
 SLVM passes             analyze, optimize, legalize
     │   IR
     ▼
 Scratch backend         IR → Scratch blocks → injected into the VM
```

---

## Planned

Unless marked *(draft)*, nothing below exists yet.

- **A small, explicit IR.** *(draft)* Structured regions rather than basic blocks and control-flow edges, because Scratch has no jumps and anything else would need a relooper to get back into C-blocks. Scratch-shaped operations (variables, lists, broadcasts, custom-block calls) instead of syntax tree nodes. See [docs/ir.md](docs/ir.md).
- **Pass infrastructure.** *(draft: an ordered pipeline that verifies after each pass)* Passes declare what they read and what they invalidate, and run in a pipeline you can inspect, reorder and disable.
- **Scratch-aware optimizations**, for example:
  - constant folding and propagation *(draft: `constfold`, using Scratch's casting rules)*
  - dead variable, dead store and unreachable-block elimination
  - loop-invariant code motion
  - inlining small custom blocks (or marking them "run without screen refresh" when that's safe)
  - strength reduction and simplification of arithmetic that Scratch evaluates the slow way
  - block-count reduction, because every block in a script is a block someone has to scroll past
- **A textual form of the IR** *(draft: `.sl`)*, so a pass's input and output can be printed and diffed, the way `.ll` files are.
- **A decompiler-friendly design**, so the IR can round-trip with what Scratchpiler's decompiler already recognizes (`pyfor`, `for`, `.sort()`, `while`).
- **A verifier** *(draft, including the tree-safety check that decides when a value must be stored in a variable before `emit`)* that rejects malformed IR before it reaches the VM, since the VM will not.

### Non-goals

- Replacing the Scratchpiler frontend, editor or injector.
- Being fast enough to matter at LLVM scale. The largest Scratch project is smaller than one LLVM test file.
- Taking itself seriously.

---

## Relationship to Scratchpiler

SLVM is a separate repository so the IR can be developed, tested and versioned without dragging the userscript along. Scratchpiler consumes it as an npm dependency (`file:../slvm` while the repositories sit side by side) and bundles it into `scratchpiler.user.js`. `slvm/testing` exports the headless scratch-vm harness for tests; it is the only part that needs the `scratch-vm` dev dependency, and it is not bundled.

---

## Naming

| LLVM | SLVM |
|---|---|
| Low Level Virtual Machine | **Scratch** Level Virtual Machine |
| `.ll` | `.sl` |
| `opt` | `slopt` |
| `llc` | `slc` |
| Compiler infrastructure for serious software | Compiler infrastructure for a cat that moves 10 steps |

---

## License

[GNU Affero General Public License v3.0](LICENSE).
