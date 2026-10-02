# SLVM IR

Draft 2. This describes what `src/` implements today, plus the parts that are still plans (each one is marked **planned**).

---

## Design in one paragraph

Scratch has no jumps. Every control structure is a C-block nested inside another one, so control flow is **structured**: no `goto`, and no basic blocks joined by edges. A flat LLVM-style control-flow graph would need a relooper just to get back into C-blocks. Scratchpiler already runs into this: `lower.js` turns `break`/`continue` into flag variables by hand. So SLVM IR is closer to WebAssembly or MLIR's `scf` dialect than to LLVM: **ops contain nested regions**, values use **SSA form inside those regions**, and **Scratch variables are the memory**. SLVM has no `mem2reg` pass and never will, because in Scratch the variables *are* the registers.

---

## Where it sits in Scratchpiler

Today (`scratchpiler/src/compiler.js:4003`, `compileSource`):

```
tokenize → parse → splice pointer helpers → lowerAST (lower.js) → compile(ast, vm) → prepareForScratchBlocks
```

`compile()` is ~2,300 lines that do three different jobs at once:

1. **name resolution** against the live VM (`resolveVar`, `resolveBroadcast`)
2. **desugaring** (`for`, `pyfor`, pointers, scratchroutines, enums, string interpolation)
3. **block JSON emission** (`addBlock`, shadows, `inputs`/`fields` wiring)

With SLVM:

```
tokenize → parse → irgen ──► SLVM passes ──► emit(ir, resolver) → prepareForScratchBlocks
                   (2)       (analysis,       (3, plus 1 through a small
                              optimization,    resolver interface wrapping vm)
                              legalization)
```

| Today | With SLVM |
|---|---|
| `lower.js` `lowerReturn` | `lower-ret`, with `spill` keeping a call result only when the next call would clobber it |
| `lower.js` `lowerBreakContinue` | `lower-break` |
| `lower.js` loop-condition rotation | `rotate-cond` (condition regions make the need explicit) |
| `lower.js` ternary/call hoisting | gone: IR is already flat SSA |
| `lower.js` `lowerMatch`, `lowerDoWhile` | stay in irgen (pure sugar) |
| pointer helpers + `promotedSlots` in `compile()` | `ptr.*` ops + `lower-ptr` pass (**planned**) |
| `compile()` `genExpr`/`genStmt` | `slc` (`src/slc/`): nearly 1:1, because IR ops are Scratch-shaped |
| `asm-opcodes.js` | passed to `slc` as `opcodes`, so it describes the `sb` op's inputs and fields (slvm ships a small fallback table) |
| linter "dead code after terminator" | a verifier rule |
| decompiler | `lift` blocks → IR, then `raise` passes rebuild `for`/`pyfor` from `_scratchpiler_internal_*` patterns (**planned**) |

The IR does not depend on the VM. Variables and procs are referenced by name, and IDs are attached only in `emit`. That lets passes be tested in plain Node with text fixtures, without `tests/mock-vm.js`.

---

## Module structure

```
stage {                          ; globals: stage variables are visible to every sprite
  var @score
  list @"high scores"
}

sprite "Cat" {                   ; one per sprite; names can be quoted
  var @vx                        ; sprite-local ("for this sprite only")
  var @_tmp internal             ; compiler-owned: passes may delete, rename or spill into it

  proc @jump(height) warp returns {
    ...
  }

  script flag { ... }            ; hats: flag, clicked, clone, receive "msg", key "space", backdrop "name"
}
```

- `@name` refers to a variable, list or proc. A variable reference looks in the sprite first, then the stage, the same way Scratch resolves names.
- `internal` marks compiler-owned variables. **Writes to a non-internal variable are never dead**: stage monitors, other sprites, clones and cloud variables can all observe them.
- `warp` means "run without screen refresh". `returns` means the proc can `ret` a value.

## Values and operands

`%n = op operand, operand` defines an SSA value. An operand can be:

| Form | Meaning |
|---|---|
| `%3` | an SSA value, which must be defined earlier in the same region or in an enclosing one |
| `42`, `-1.5`, `"text"` | a literal (it becomes a shadow input on the block) |
| `true`, `false` | a boolean literal (has no block form; see legalization) |
| `@x` | a variable, list or proc symbol |
| `w` | a proc parameter name (only used as the operand of `arg`) |

The printer renumbers values in definition order, so `print` is a fixed point of `parse`.

### Types

There are two types, and they mirror block shapes:

- **`bool`**: hexagonal reporters (`lt gt eq and or not contains list.has arg.b`, and boolean `sb` reporters)
- **`val`**: everything else (round reporters)

The verifier enforces Scratch's one-way slot rule: a `bool` can go into a `val` slot, but a `val` cannot go into a boolean slot (`if`, `cond`, `and`, `or`, `not`). The VM would accept the cast, but the editor and the decompiler would not.

### Effects

Every op has an effect: `pure < read < write < yield`, plus `control` for structural ops.

- **pure**: depends only on its operands. Can be folded and deleted. **Not** necessarily "algebraically nice": `add %x, 0` casts `"abc"` to `0` and `"1.50"` to `1.5`, so it is *not* an identity.
- **read**: reads Scratch state (`var.get`, `list.get`, `random`, sensing reporters). Can be deleted if unused. Cannot be folded, or moved past a write or a yield.
- **write**: changes state that other scripts can observe.
- **yield**: may give up the thread (`wait`, `broadcast.wait`, `*forsecs`, `glide`, `ask`, non-`warp` loops, calls). Other scripts run at this point, so any non-internal variable may have changed.

## Ops

| Group | Ops |
|---|---|
| arithmetic | `add sub mul div mod round`, `math.{abs floor ceiling sqrt sin cos tan asin acos atan ln log exp pow10}` |
| compare / logic | `lt gt eq and or not` |
| strings | `join letter length contains` |
| misc reporters | `random`, `arg name`, `arg.b name` |
| variables | `var.get @v`, `var.set @v, x`, `var.change @v, x` |
| lists | `list.get @l, i`, `list.len @l`, `list.has @l, x`, `list.index @l, x`, `list.add @l, x`, `list.del @l, i`, `list.ins @l, i, x`, `list.set @l, i, x`, `list.clear @l` (indices are 1-based, as in Scratch) |
| events | `broadcast m`, `broadcast.wait m`, `wait secs`, `stop "all" \| "this script" \| "other scripts in sprite"` |
| procs | `call @p(args)`, `%r = call @p(args)`, `ret`, `ret x` |
| control | `if c {} else {}`, `repeat n {}`, `forever {}`, `until {cond region} do {body}`, `wait.until {cond region}` |
| loop exits | `break`, `continue` |
| everything else | `sb opcode(KEY: x, ...)` / `%r = sb opcode(...)`: any Scratch opcode, the same way intrinsics work in LLVM |

There is only one kind of loop condition, `until`, because Scratch has no native `while`. irgen emits `while c` as `until (not c)`, and constfold removes double negation.

**Condition regions.** `until` and `wait.until` re-evaluate their condition on every iteration, so the condition is a *region* that ends in `cond %v`, not a single value. Before legalization, a condition region may contain calls. Legalization rotates those out (see below).

**Terminators.** `ret`, `break`, `continue`, `stop "all"`, `stop "this script"`, and a `forever` with no `break` out of it, must be the last op in their region (Scratch cap blocks). `stop "other scripts in sprite"` is not a cap block, which matches Scratch.

### Example

`scratchpiler/examples/return-functions.sdsl` as irgen would produce it (`examples/return-functions.sl`):

```
proc @fact(n) warp returns {
  %0 = arg n
  %1 = lt %0, 2
  if %1 {
    ret 1
  }
  %2 = sub %0, 1
  %3 = call @fact(%2)
  %4 = mul %0, %3
  ret %4
}
```

---

## Two stages: canonical and legal

The IR has two levels. `verify(mod)` checks **canonical** IR, which is what irgen and the optimizations work on. `verify(mod, { legal: true })` additionally checks that `emit` can produce blocks from it. `-p legalize` runs these passes, in this order:

| Rejected in legal IR | Pass | Lowering |
|---|---|---|
| `ret x` | `lower-ret` | `var.set @__ret_<p>, x` + `stop "this script"`. A `stop` at the very end of a proc body is dropped |
| `%r = call ...` | `lower-ret` | `call` + `%r = var.get @__ret_<p>`. Whether `%r` needs a temp is left to `spill` |
| `break`, `continue` | `lower-break` | flag variables + guards, as in `lower.js`; see below |
| writes/calls in a condition region | `rotate-cond` | see below |
| `true`/`false` in a boolean slot | `materialize-bool` | `eq "1", "1"` / `eq "1", "0"`, the same blocks `compile()` emits today |
| a value that is not tree-safe | `spill` | see below |

`lower-ptr` is still **planned**, because there are no `ptr.*` ops yet.

New internal variables are named `_scratchpiler_internal_slvm_<tag><n>`. `slvm` fills the 4-character slot in the decompiler's `_scratchpiler_internal_[a-z0-9]{4}_` pattern, so the decompiler still treats them as hidden.

### lower-break

This pass works from the innermost loop outward.
- **Body:** each `break`/`continue` becomes `var.set @brk|@cont, 1`. Everything that follows an op that may have set a flag is wrapped in `if (brk = 0 and cont = 0)`. A loop with a `continue` resets its flag at the top of the body.
- **`forever` with `break`:** becomes `until (brk = 1)`.
- **`until c` with `break`:** becomes `until (c or brk = 1)`.
- **`repeat n` with `break`:** becomes a counter loop `until (not (k < round n) or brk = 1)`. The counter increment sits outside the guards, so `continue` still counts the iteration. `round` keeps Scratch's rounding of the count (`repeat 2.4` runs twice); for a literal count it is computed at compile time.
- **`continue` only:** keeps the native loop.

### rotate-cond

When a condition region contains an op that writes or yields (in practice, a `call` left by `lower-ret`), its ops run once before the loop and again at the end of the body. The result goes into a `rot` flag variable, and the condition becomes `var.get @rot = "true"`. That comparison works because Scratch's `"true" = true` compares as strings. `wait.until` with such a condition becomes an `until` loop with the re-evaluation as its body. A Scratch loop yields once per iteration, the same way `wait until` polls once per frame, so the timing is unchanged.

### Tree-safety and spill

Scratch evaluates a reporter tree *at the moment its block runs*, so `emit` will nest every value into its single consumer. A value's **evaluation point** is the first op up its consumer chain that has no result: the statement whose block will run the tree. A value is **clobbered** when, somewhere between its definition and that point, in execution order:

- an op writes state it reads (`var:x`, `list:l`, `world` for sensing/motion, or anything for a `call`, using per-proc write summaries that are closed over the call graph), or
- something yields and the value reads non-internal state (other scripts run at a yield), or
- the interval contains a loop, the value is defined outside it and used inside, and the loop yields at its back-edge (any loop outside a `warp` proc).

`spill` repeats the following until no hazard is left:

1. **Pure tree used more than once** (for example `arg n`, or `sub (arg n), 1`): clone the whole tree before each extra use (up to 8 ops).
2. **Read used more than once, unclobbered at every use** (for example `[steps]` read three times with nothing writing it in between): re-read it at each use instead of storing it. `random` is never re-read.
3. **Anything else used more than once, or a single-use value that is clobbered**: store it in an internal temp right after its definition, and reload it right before each consumer. If the consumer is itself a value and the hazard comes later, the consumer is spilled instead, which keeps the reload next to where it is used.
4. **The temp would be clobbered by recursion**: when a call between the store and the reload can reach the current proc, a plain temp would be overwritten by the inner activation. The value is pushed to the `_scratchpiler_internal_slvm_stack` list instead, and popped into a temp right before its use. Every `stop "this script"` in between gets a pop first, so early returns leave the stack balanced.

With these rules, `return-functions.sl` needs one temp (`lower.js` makes three), and `loops.sl` needs none. `fib.sl` computes `fib(10) = 55` and finishes with an empty stack; `lower.js` reuses one `_rv` variable per call site at every recursion depth, so its output for `fib` gets this wrong.

Known limits, which raise `LegalizeError` instead of producing wrong code:
- **Multiple uses across recursion:** a value used more than once across a recursive call. Only compiler temporaries hit this; variables in the source are ordinary Scratch variables.
- **Stack values in loop conditions:** a stack-spilled value read inside a loop condition, which would need a stack peek.

Not detected:
- **Concurrent callers:** plain temps in a non-`warp` proc that yields between store and reload can be overwritten when another thread runs the same proc at the same time. The spill stack has the same problem. `lower.js`'s temps share this.

`verify(mod, { legal: true })` runs the same hazard search, so it reports any value that `emit` would evaluate at the wrong moment.

---

## Reference interpreter

`run(mod, { tree })` in `src/interp.js` runs every `flag` script once, on a single thread (yields do nothing). It returns the variables, the lists and a trace of `sb`/`broadcast` ops.

- **Eager mode** evaluates each value where it is defined. This is the meaning of the IR.
- **Tree mode** (`tree: true`) evaluates a value only when a statement uses it, re-evaluating its whole tree each time, which is what the emitted blocks will do.

`test/legalize.test.js` runs every example eagerly before legalization and in tree mode after it, and requires the same result. The same test checks that removing `spill` from the pipeline makes `return-functions.sl` and `fib.sl` compute wrong answers. Programs that never stop (a bare `forever`) are skipped.

---

## slc: IR → Scratch blocks

`slc(mod, options)` in `src/slc/` takes **legal** IR (it runs `verify(mod, { legal: true })` and throws `SlcError` otherwise). For each target it returns `{ kind, name, variables, blocks }`. `blocks` is a map in scratch-vm's in-memory format (`inputs: { NAME: { name, block, shadow } }`, `fields: { NAME: { name, value, id? } }`), the same format `compile()` returns and `injectBlocks` loads.

- **Statements:** every op without a result becomes a block, chained with `next`/`parent`. Loop and `if` bodies become `SUBSTACK`/`SUBSTACK2`.
- **Values:** a value op does not produce a block where it is defined. Its single consumer nests it as a reporter. `spill` has already made that safe.
- **Slots:** number and text slots always get a `math_number`/`text` shadow, with the reporter on top when there is one. Boolean slots take the reporter with no shadow. A boolean literal is `1`/`0` in a number slot and `true`/`false` in a text slot, because Scratch casts `true` to `1` in arithmetic but would cast the text `"true"` to `0`.
- **Procs:** the proccode is `name %s ...`, matching `compile()`. A parameter becomes `%b` with `argument_reporter_boolean` when the body reads it with `arg.b`. Calls and prototypes share argument ids. `warp` becomes the `warp` mutation.
- **Variables and broadcasts:** every declaration gets an id from `resolveVariable(target, decl)`, or a fresh one. Broadcast messages (from `broadcast` ops and `receive` hats) become `broadcast_msg` variables on the stage, using `resolveBroadcast(name)`. Scratchpiler will pass resolvers that wrap its existing `resolveVar`/`resolveBroadcast`, so the VM stays out of slvm.
- **`sb` ops:** `options.opcodes` uses the `ASM_OPCODES` format from Scratchpiler's `asm-opcodes.js`. A key without a schema becomes a text input.
- **Block ids:** come from `options.uid`, by default a deterministic counter, so output can be compared in tests.

`slc` is checked three ways in `test/slc.test.js`:
1. **Structure:** every `next`/`parent`/input reference exists and points back correctly, and every field id is a declared variable.
2. **Real VM:** each example is legalized, compiled, loaded into a real headless **scratch-vm** (`test/scratch-vm.js`), and run from the green flag on a virtual clock. Its final variables, lists and speech bubbles must match the interpreter's result for the original IR.
3. **Decompiler:** when a sibling `../scratchpiler` checkout exists, Scratchpiler's decompiler must turn the output back into source that Scratchpiler compiles without errors.

---

## Value semantics

Constant folding uses Scratch's casting rules, not JavaScript's (`src/cast.js`, which mirrors `scratch-vm`'s `Cast`):

| Expression | Scratch | Naive JS |
|---|---|---|
| `eq "Apple", "APPLE"` | `true` | `false` |
| `eq "10", "10.0"` | `true` | `false` |
| `lt " ", 1` | `true` (a whitespace-only string compares as a string) | `true` for the wrong reason |
| `add "abc", 1` | `1` | `"abc1"` |
| `mod -1, 3` | `2` | `-1` |
| `math.sin 30` | `0.5` (rounded to 10 places) | `0.49999999999999994` |

Results that are not finite (`div 1, 0`) are left for the runtime instead of being folded.

---

## Passes

| Pass | Status | Does |
|---|---|---|
| `constfold` | done | folds pure ops with Scratch semantics; boolean identities and `not not`; folds `if` with a constant condition, `repeat` ≤ 0 and `until`/`wait.until` that are already true; drops code after a terminator it exposes |
| `dce` | done | removes unused `pure`/`read` ops until nothing changes; never removes writes |
| `dse` | planned | dead stores, **only to `internal` variables** |
| `licm` | planned | hoisting out of loops is only legal over pure ops, or over reads with no write/yield in the loop |
| `inline` | planned | inline small procs; a `warp` callee inlined into a non-warp caller must keep its body atomic |
| `warp-infer` | planned | mark procs `warp` when that cannot change behavior (no yields, bounded loops, no visible effects mid-body) |
| `event-graph` | planned analysis | broadcast → receivers, and the variable read/write sets for each script. It feeds yield-aware tree-safety and finds broadcast-as-goto chains like `spaghetti-goto.sdsl` (the thread model is in `scratchpiler/observations.md`) |
| `lower-ret`, `lower-break`, `rotate-cond`, `materialize-bool`, `spill` | done | legalization, see above; `-p legalize` runs all of them in order |
| `lower-ptr` | planned | pointer ops → `__heap` list accesses |

The optimizations still to build, in priority order and with their legality conditions, are in [optimizations.md](optimizations.md).

`runPipeline(mod, names, { verifyEach, printAfterAll })` runs the passes in order and re-verifies after each one, like `opt -verify-each`.

---

## Tools

```
node bin/slopt.js -p constfold,dce examples/fold.sl
node bin/slopt.js --print-after-all -p constfold,dce examples/fold.sl
node bin/slopt.js -p legalize --legal examples/fib.sl
node bin/slc.js -p legalize examples/fib.sl
npm test
```

| LLVM | SLVM |
|---|---|
| `.ll` | `.sl` |
| `opt` | `slopt` |
| `llc` | `slc` |

---

## Open questions

- **Clones.** Sprite-local variables exist once per clone. Does a `clone` hat script need its own view of "internal" variables, or is per-clone storage already enough?
- **Scratchroutines.** Should they be lowered in irgen (to broadcast + hidden variables, as now), or kept as a `spawn @routine(args)` op so the event-graph analysis can see them?
- **Source locations.** Ops keep `line` from the `.sl` text. irgen should store the `.sdsl` location instead, so diagnostics from SLVM passes point at the user's code.
- **Pointers.** `ptr.load`/`ptr.store`/`addr` ops plus `lower-ptr`, or keep the `__heap` list explicit in irgen?
