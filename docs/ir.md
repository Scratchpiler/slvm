# SLVM IR

Draft 4. This describes what `src/` implements today, plus the parts that are still plans (each one is marked **planned**).

---

## Design in one paragraph

Scratch has no jumps. Every control structure is a C-block nested inside another one, so control flow is **structured**: no `goto`, and no basic blocks joined by edges. A flat LLVM-style control-flow graph would need a relooper just to get back into C-blocks. SLVM lowers `break`/`continue` into flag variables during legalization. So SLVM IR is closer to WebAssembly or MLIR's `scf` dialect than to LLVM: **ops contain nested regions**, values use **SSA form inside those regions**, and **Scratch variables are the memory**. SLVM has no `mem2reg` pass and never will, because in Scratch the variables *are* the registers.

---

## Where it sits in Scratchpiler

Every Scratchpiler compile uses:

```text
include expansion → tokenize → parse → irgen → SLVM legalize → slc → inject
```

IR generation lives in Scratchpiler's `src/irgen.js`; `src/slvm-backend.js` connects the module to live VM variables, broadcasts and external custom blocks. The former direct block emitter and `lower.js` have been removed. Scratchpiler's [compiler documentation](../../scratchpiler/docs/slvm-backend.md) describes behavior, restrictions and verification.

| Source construct | Implementation |
|---|---|
| returning calls and `return` | `lower-ret`, with `spill` preserving values across calls |
| `break` / `continue` | `lower-break` |
| calls in loop conditions | `rotate-cond` |
| ternaries | explicit IR regions and temporary values from irgen |
| `match`, `do … while`, list sugar | expanded by irgen |
| pointers | irgen emits `list.get` / `list.set` / `list.index` on `__heap` / `__ptab`; VM glue promotes global scalars |
| motion, looks, sound, pen, sensing, assembly | `sb` operations; `slc` uses the supplied opcode schema |
| block emission | `src/slc/`, with VM resolver hooks |
| decompiler | Scratchpiler reads blocks directly; IR lifting remains **planned** |

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
  var @steps confined            ; only one thread ever touches it (a whole-program fact)

  proc @jump(height) warp returns {
    ...
  }

  proc @dash(speed) extern {      ; exists in the project as blocks; called, never emitted
  }

  script flag { ... }            ; hats: flag, clicked, clone, receive "msg", key "space", backdrop "name", greater "TIMER" 10
  script receive "go" uninterrupted { ... }   ; no other thread can stop or restart it

  script greater "TIMER" with {  ; a hat region: the threshold as a reporter
    %0 = var.get @limit
    value %0
  } { ... }
}
```

- `@name` refers to a variable, list or proc. A variable reference looks in the sprite first, then the stage, the same way Scratch resolves names.
- `internal` marks compiler-owned variables. **Writes to a non-internal variable are never dead**: stage monitors, other sprites, clones and cloud variables can all observe them.
- **`confined`** says that only one thread ever reads or writes the variable. SLVM cannot check this: it is a whole-program fact that the client supplies (Scratchpiler derives it from its project analysis, see `docs/code-intelligence.md` there). A sprite-local variable counts as one per clone, because every clone has its own copy. A yield cannot change a confined variable, so `spill` treats it like an internal one, and the unroller may unroll loops over it outside `warp` (below).
- **`uninterrupted`** on a script or proc says that the code runs in one thread only, and that no other thread can stop or restart that thread: nothing else broadcasts its message or switches to its backdrop, and nothing runs `stop all`, `stop other scripts in sprite` or `delete this clone` around it. User input (green flag, keys, clicks) still can, but it only arrives between frames, as it does on a slower or faster computer. This is also a client-supplied fact.
- `warp` means "run without screen refresh". `returns` means the proc can `ret` a value.
- **`noinline`** tells the `inline` pass never to inline this proc. It does not change what the proc does.
- An **`extern`** proc has a signature but no body: it already exists in the project as blocks. `slc` asks `resolveProc(target, proc)` for its real proccode and argument ids and emits only the calls. Its effects are unknown, so analysis assumes it may write anything, yield, and call back into any proc (which forces `spill` to use the stack across it). A call to an extern proc cannot use a return value.
- A **hat region** (`with { … value %v }`) computes a hat's input as a reporter tree. It may only contain value ops that read or are pure, each used exactly once, and must end with `value`. `slc` nests the tree into the hat's `VALUE` input.

### Loop hints and tags

- **`nounroll`** follows the operands of a `repeat` or `until` op (`repeat 8 nounroll { … }`, `until nounroll { … } do { … }`) and tells the `unroll` pass to leave the loop alone. The verifier rejects it on any other op. `lower-break` and `rotate-cond` replace loops with new `until` ops, and they carry `nounroll` across.
- **`tag`** is opaque client data on a proc, a script or a statement op. Passes never read it. `lower-break` and `rotate-cond` keep it on the loop they produce, and `slc` echoes it back as `{ blockId, tag }` entries in the target's `tags` list (see slc below). A tag on a value op is ignored, since a value op has no block of its own. Tags exist only as JavaScript values: the text format neither prints nor parses them.

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

- **`bool`**: hexagonal reporters (`lt gt eq and or not contains list.has arg.b truthy`, and boolean `sb` reporters)
- **`val`**: everything else (round reporters)

The verifier enforces Scratch's one-way slot rule: a `bool` can go into a `val` slot, but a `val` cannot go into a boolean slot (`if`, `cond`, `and`, `or`, `not`).

Source code does put round values in boolean slots (`if [flag] { }`). Scratch's VM accepts that and casts with its truthiness rules, and Scratchpiler source permits it. For that case there is **`truthy %v`**, a `bool` op whose value is Scratch's `toBoolean(v)`. It has no block of its own: `slc` places `%v`'s reporter directly in the boolean slot. A `truthy` of a literal has no reporter to place, so `materialize-bool` replaces it with `"1" = "1"` or `"1" = "0"`.

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
| compare / logic | `lt gt eq and or not`, `truthy` |
| strings | `join letter length contains` |
| misc reporters | `random`, `arg name`, `arg.b name` |
| variables | `var.get @v`, `var.set @v, x`, `var.change @v, x`, `var.show @v`, `var.hide @v` |
| lists | `list.get @l, i`, `list.len @l`, `list.has @l, x`, `list.index @l, x`, `list.add @l, x`, `list.del @l, i`, `list.ins @l, i, x`, `list.set @l, i, x`, `list.clear @l`, `list.show @l`, `list.hide @l`, `list.contents @l` (the list as a value: items joined with spaces, or with nothing if every item is one character, as Scratch's list reporter does; indices are 1-based, as in Scratch) |
| events | `broadcast m`, `broadcast.wait m`, `wait secs`, `stop "all" \| "this script" \| "other scripts in sprite"` |
| procs | `call @p(args)`, `%r = call @p(args)`, `ret`, `ret x` |
| control | `if c {} else {}`, `repeat n {}`, `forever {}`, `until {cond region} do {body}`, `until {cond} do {body} step {latch}`, `wait.until {cond region}` |
| loop exits | `break`, `continue` |
| everything else | `sb opcode(KEY: x, ...)` / `%r = sb opcode(...)`: any Scratch opcode, the same way intrinsics work in LLVM |

There is only one kind of loop condition, `until`, because Scratch has no native `while`. irgen emits `while c` as `until (not c)`, and constfold removes double negation.

**Step regions.** `until` can take a third region, `step`, that runs after every iteration: after the body finishes normally, and also after a `continue`. `break` skips it. irgen uses it for the increment of `for`/`pyfor` and for the condition re-check of `do … while`, which is what makes `continue` correct in those loops. `lower-break` merges it into the body *outside* the `continue` guards (inside an `if brk = 0` when the loop has a `break`), so legal IR never has one.

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
| `break`, `continue` | `lower-break` | flag variables + guards, using compiler flag variables; see below |
| writes/calls in a condition region | `rotate-cond` | see below |
| `true`/`false` in a boolean slot | `materialize-bool` | `eq "1", "1"` / `eq "1", "0"`, Scratch-compatible comparison reporters |
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
- **`step` region:** appended to the body after the guards, so `continue` still reaches it. It sits inside an `if brk = 0` when the loop also has a `break`.

### rotate-cond

When a condition region contains an op that writes or yields (in practice, a `call` left by `lower-ret`), its ops run once before the loop and again at the end of the body. The result goes into a `rot` flag variable, and the condition becomes `var.get @rot = "true"`. That comparison works because Scratch's `"true" = true` compares as strings. `wait.until` with such a condition becomes an `until` loop with the re-evaluation as its body. A Scratch loop yields once per iteration, the same way `wait until` polls once per frame, so the timing is unchanged.

### Tree-safety and spill

Scratch evaluates a reporter tree *at the moment its block runs*, so `emit` will nest every value into its single consumer. A value's **evaluation point** is the first op up its consumer chain that has no result: the statement whose block will run the tree. A value is **clobbered** when, somewhere between its definition and that point, in execution order:

- an op writes state it reads (`var:x`, `list:l`, `world` for sensing/motion, or anything for a `call`, using per-proc write summaries that are closed over the call graph), or
- something yields and the value reads state that is neither internal nor `confined` (other scripts run at a yield), or
- the interval contains a loop, the value is defined outside it and used inside, and the loop yields at its back-edge (any loop outside a `warp` proc).

`spill` repeats the following until no hazard is left:

1. **Pure tree used more than once** (for example `arg n`, or `sub (arg n), 1`): clone the whole tree before each extra use (up to 8 ops).
2. **Read used more than once, unclobbered at every use** (for example `[steps]` read three times with nothing writing it in between): re-read it at each use instead of storing it. `random` is never re-read.
3. **Anything else used more than once, or a single-use value that is clobbered**: store it in an internal temp right after its definition, and reload it right before each consumer. If the consumer is itself a value and the hazard comes later, the consumer is spilled instead, which keeps the reload next to where it is used.
4. **The temp would be clobbered by recursion**: when a call between the store and the reload can reach the current proc, a plain temp would be overwritten by the inner activation. The value is pushed to the `_scratchpiler_internal_slvm_stack` list instead, and popped into a temp right before its use. Every `stop "this script"` in between gets a pop first, so early returns leave the stack balanced.

With these rules, `return-functions.sl` needs one temp and `loops.sl` needs none. `fib.sl` computes `fib(10) = 55` and finishes with an empty stack.

Known limits, which raise `LegalizeError` instead of producing wrong code:
- **Multiple uses across recursion:** a value used more than once across a recursive call. Only compiler temporaries hit this; variables in the source are ordinary Scratch variables.
- **Stack values in loop conditions:** a stack-spilled value read inside a loop condition, which would need a stack peek.

Not detected:
- **Concurrent callers:** plain temps in a non-`warp` proc that yields between store and reload can be overwritten when another thread runs the same proc at the same time. The spill stack has the same problem.

`verify(mod, { legal: true })` runs the same hazard search, so it reports any value that `emit` would evaluate at the wrong moment.

---

## Reference interpreter

`run(mod, { tree })` in `src/interp.js` runs every `flag` script once, on a single thread (yields do nothing). It returns the variables, the lists and a trace of `sb`/`broadcast` ops.

- **Eager mode** evaluates each value where it is defined. This is the meaning of the IR.
- **Tree mode** (`tree: true`) evaluates a value only when a statement uses it, re-evaluating its whole tree each time, which is what the emitted blocks will do.

`test/legalize.test.js` runs every example eagerly before legalization and in tree mode after it, and requires the same result. The same test checks that removing `spill` from the pipeline makes `return-functions.sl` and `fib.sl` compute wrong answers. Programs that never stop (a bare `forever`) are skipped.

---

## slc: IR → Scratch blocks

`slc(mod, options)` in `src/slc/` takes **legal** IR (it runs `verify(mod, { legal: true })` and throws `SlcError` otherwise). For each target it returns `{ kind, name, variables, blocks, tags }`. `blocks` is a map in scratch-vm's in-memory format (`inputs: { NAME: { name, block, shadow } }`, `fields: { NAME: { name, value, id? } }`), the format Scratchpiler returns and `injectBlocks` loads.

- **Statements:** every op without a result becomes a block, chained with `next`/`parent`. Loop and `if` bodies become `SUBSTACK`/`SUBSTACK2`.
- **Values:** a value op does not produce a block where it is defined. Its single consumer nests it as a reporter. `spill` has already made that safe.
- **Slots:** number and text slots always get a `math_number`/`text` shadow, with the reporter on top when there is one. Boolean slots take the reporter with no shadow. A boolean literal is `1`/`0` in a number slot and `true`/`false` in a text slot, because Scratch casts `true` to `1` in arithmetic but would cast the text `"true"` to `0`.
- **Procs:** the proccode is `name %s ...`, matching Scratchpiler source definitions. A parameter becomes `%b` with `argument_reporter_boolean` when the body reads it with `arg.b`. Calls and prototypes share argument ids. `warp` becomes the `warp` mutation.
- **Variables and broadcasts:** every declaration gets an id from `resolveVariable(target, decl)`, or a fresh one. Broadcast messages (from `broadcast` ops and `receive` hats) become `broadcast_msg` variables on the stage, using `resolveBroadcast(name)`. Scratchpiler's `slvm-backend.js` passes resolvers that look names up in the live project, so the VM stays out of slvm.
- **`sb` ops:** `options.opcodes` uses the `ASM_OPCODES` format from Scratchpiler's `asm-opcodes.js`. A key without a schema becomes a text input. Besides `number`/`string`/`boolean`/`menu`, a param can use `valueType: 'color'`, which gets a `colour_picker` shadow.
- **Hats:** `greater "TIMER" 10` becomes `event_whengreaterthan` with a `math_number` `VALUE` input.
- **Tags:** a proc's tag attaches to its `procedures_definition` block, a script's to its hat, and a statement's to the block `slc` emits for it. `tags` lists `{ blockId, tag }` in emission order. Scratchpiler uses them to attach comments to blocks without teaching slvm anything about comments.
- **Block ids:** come from `options.uid`, by default a deterministic counter, so output can be compared in tests.

`slc` is checked three ways in `test/slc.test.js`:
1. **Structure:** every `next`/`parent`/input reference exists and points back correctly, and every field id is a declared variable.
2. **Real VM:** each example is legalized, compiled, loaded into a real headless **scratch-vm** (`src/testing/scratch-vm.js`, exported as `slvm/testing` so Scratchpiler's tests can use it too), and run from the green flag on a virtual clock. Its final variables, lists and speech bubbles must match the interpreter's result for the original IR.
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
| `constfold` | done | folds pure ops with Scratch semantics; boolean identities and `not not`; merges adjacent literals in nested `join`s; folds `if` with a constant condition, `repeat` ≤ 0 and `until`/`wait.until` that are already true; drops code after a terminator it exposes |
| `dce` | done | removes unused `pure`/`read` ops until nothing changes; never removes writes. Also removes an unused `call` to a *discardable* proc (no writes, no effects on the world, no explicit yield, cannot diverge; see [optimizations.md](optimizations.md#1c-effect-summaries-and-unused-calls)). Run it before `lower-ret` |
| `dse` | done | within straight-line code: a store overwritten before anything can see it, `set` + `change` with literals folded into one `set`, and a read of a known literal replaced by it. Applies to shared variables too, because nothing can observe a value between two stores with no yield; see [optimizations.md](optimizations.md#2-copy-propagation-and-dead-stores) |
| `dead-vars` | done, opt-in | deletes writes to `internal` variables and lists that nothing reads. Not in `-O1` (it erases the hidden item of an unused `pyfor`, which the decompiler needs) |
| `indvars` | done | `for`-shaped `until` loops whose iterator is never read become `repeat`, when the bounds are provably finite integers and the end is invariant; see [optimizations.md](optimizations.md#1d-counted-for--repeat-indvars) |
| `licm` | planned | hoisting out of loops is only legal over pure ops, or over reads with no write/yield in the loop |
| `inline` | done | inlines small non-recursive procs at call sites outside loop conditions; see [optimizations.md](optimizations.md#1-inlining-returning-procs-then-folding--o1); skips `noinline` procs; `-p O1` runs `inline`, `constfold`, `indvars`, `unroll`, `constfold`, `dse`, `constfold`, `dce`, then `legalize` |
| `unroll` | done | unrolls constant-count `repeat` loops and `for`-shaped `until` loops inside `warp` procs, within a trip and size budget; skips `nounroll` loops; never touches loops that yield today; see [optimizations.md](optimizations.md#1b-unrolling-counted-loops) |
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

- **Clones.** Internal loop and temporary variables live on the sprite, so each clone has its own copy. `control_delete_this_clone` can continue on an original sprite and is not an unconditional IR terminator.
- **Scratchroutines.** Should they be lowered in irgen (to broadcast + hidden variables, as now), or kept as a `spawn @routine(args)` op so the event-graph analysis can see them?
- **Source locations.** Ops keep `line` from the `.sl` text, but irgen doesn't attach `.sdsl` locations yet, so a `LegalizeError` is reported at line 1 of the source.
- **External custom blocks.** `extern proc` signatures import existing project prototypes; the VM adapter resolves their actual proccodes and argument IDs.
- **Pointers.** `ptr.load`/`ptr.store`/`addr` ops plus `lower-ptr`, or keep the `__heap` list explicit in irgen?

## Verifier failures

Duplicate target identities, duplicate variable declarations of the same kind, duplicate procedure names and duplicate parameters are rejected. A scalar and a list may share a name because Scratch distinguishes their types.

`runPipeline` raises `VerificationError` when verification fails after a pass. Scratchpiler returns this as a compiler diagnostic. The block emitter can materialize literal boolean arguments in schema-defined boolean inputs and external procedure inputs; core boolean operands still pass through `materialize-bool`.
