# Optimization roadmap

Where SLVM's optimizer should go next, in the order I'd build it. Each pass says what it does, when it is legal under Scratch's semantics, and what evidence it would need before it ships. Everything here is **planned** unless it says otherwise.

---

## What "faster" means in Scratch

LLVM optimizes cycles. Scratch has three different costs, and they pull in different directions:

| Cost | What it measures | Who notices |
|---|---|---|
| **Static blocks** | blocks in the project | the person scrolling through the code; project size |
| **Dynamic blocks** | blocks executed per run; each one is an interpreter dispatch in scratch-vm | CPU, and frame rate in heavy projects |
| **Frames** | ticks until a script finishes | everyone, because this is what looks slow |

The measurement taken while building `slc` changed this roadmap. A non-`warp` loop yields after each iteration, but scratch-vm's sequencer then **runs it again in the same tick** unless a redraw was requested or 75% of the frame's time budget is used up (`sequencer.js`, `stepThreads`). Data-only loops never request a redraw, so `loops.sl` finishes in **0 frames** whether or not it runs in a `warp` proc. Frames only become the bottleneck when:

- the loop also draws (motion, looks or pen blocks request a redraw), in which case `warp` would visibly change behaviour, or
- the work is larger than the frame budget, in which case dynamic block count is what matters.

So most of the payoff is in **dynamic blocks**, then **static blocks**, and frames only in specific, detectable cases.

Today's numbers after `-p legalize` + `slc` (all blocks / non-shadow blocks):

| Example | Blocks | Non-shadow |
|---|---|---|
| `loops.sl` | 113 | 65 |
| `fib.sl` | 48 | 28 |
| `return-functions.sl` | 72 | 36 |

---

## 0. Measurement and differential testing (first)

Before any new optimization:

- **`slc --stats`**: static block counts, plus dynamic counts from the interpreter in tree mode (count every op it evaluates). That is exactly the number of blocks scratch-vm would dispatch. **Partly done:** `run()` in `src/interp.js` now returns `blocks`, the number of statements executed plus value ops evaluated (a `cond` is not counted, and a loop counts once per entry, not per iteration). In tree mode this is the dispatch count of the legalized program. There is no `--stats` flag yet.
- **Frames with a redraw model**: `test/scratch-vm.js` currently has no renderer, so nothing ever requests a redraw. A stub that calls `runtime.requestRedraw()` from the blocks that would draw (motion, looks, pen) would make the frame counts realistic.
- **A random program generator.** Structured IR is easy to generate: nested `if`/`repeat`/`until`, arithmetic on a few variables, procs with `ret`, `break`/`continue`, recursion with bounded depth. Every generated program runs through every pipeline (`legalize`, and `O1`/`O2` once those exist), and three results must agree: the interpreter in eager mode before, the interpreter in tree mode after, and the real scratch-vm after.

The fuzzer is the single best investment. Every bug found while building legalization and `slc` showed up as a disagreement between two of these runs: the `forever`-with-`break` terminator, spill re-iterating a list it was editing, `sayforsecs` running on real timers, undeclared variables missing from the interpreter's results.

---

## 1. Inlining returning procs, then folding (`-O1`)

**Done:** `src/passes/inline.js`, run by `-p inline` or as the first step of `-p O1` (see [Pipelines](#pipelines)).

**The biggest structural win.** Every `define ... returns` call costs a `procedures_call`, a `var.set @__ret_f`, a `stop`, a `var.get @__ret_f`, and sometimes a spill. Inlining a small non-recursive returning proc into its caller removes all of that:

```
%0 = call @rectArea(6, 7)        →        %0 = mul 6, 7        →        42
```

Procs are processed callees first, so a body is already inlined by the time its caller copies it. The definition always stays in the module.

**What the pass inlines:** a call to a proc that

- is not `extern`, not `noinline`, and not part of a recursive cycle (`summarize` computes `reaches`);
- has at most `INLINE_LIMIT` ops (24) after its own calls were inlined;
- contains no `forever` and no `stop` other than `stop "other scripts in sprite"`. A `stop "this script"` inside a proc returns from the proc, but inlined it would end the caller's script, and a terminator in the middle of the caller would leave dead code after it;
- keeps its `warp` atomicity: a `warp` callee goes into a non-warp caller only if nothing in its body can yield there (no loops, no waits, no calls to non-warp procs). A non-`warp` callee can go anywhere, since a warp caller already ran it without yielding;
- has `ret`s only in tail position. A `ret` inside an `if` that is followed by more ops is folded by moving the rest into the other arm (`if c { ret a } rest` becomes `if c { ret a } else { rest }`). A `ret` inside a loop, or one that cannot be folded, keeps the call;
- returns a value on every path when the call's result is used. Falling off the end would read a stale `@__ret_f` in the original, which the inlined body cannot reproduce.

**Where it does not look:** calls inside a loop condition region, and hat regions. A call whose result is unused is inlined without its return value.

**How it substitutes:**

- `arg p` becomes the caller's operand. SSA values are immutable, so a read passed as an argument keeps its old value even when the callee writes the same variable; `spill` then decides what needs a temporary, exactly as for any other value.
- `arg.b p` becomes the operand itself when it is already a `bool`, and `truthy operand` otherwise, because `argument_reporter_boolean` casts with `toBoolean`.
- A boolean literal passed to an `arg` becomes the text `"true"`/`"false"`, because a text parameter slot receives text in the real VM.
- A single trailing `ret v` becomes the value `v`. Returns inside `if` arms store to a fresh internal `@_scratchpiler_internal_slvm_inlN` and read it once after the `if`.

**Checked by:** `test/inline.test.js` runs each program before and after in the interpreter (eager, and tree mode after legalization), runs every example through the real scratch-vm after `O1`, and Scratchpiler's differential fuzzer runs with inlining on.

**Not done yet:** inlining a proc with several non-foldable early returns, calls in loop conditions, and a size heuristic that weighs call count and callee size together.

- `noinline`: a proc flag in the IR (`proc @f(x) noinline`). The pass skips a `noinline` proc even when it is small and non-recursive. Scratchpiler source spells it `define f(x) noinline { }`.

After inlining, `constfold` + `dce` remove the leftovers, and `spill` usually has nothing left to do.

**Result:** `return-functions.sl` loses all three `call`s from its script; after `O1` the first becomes `var.set @area, 42`.

## 1b. Unrolling counted loops

**Done:** `src/passes/unroll.js`, run by `-p unroll` or inside `-p O1` (`inline`, `constfold`, `unroll`, `constfold`, `dce`, `legalize`). Unrolling a loop removes the yield at its back-edge, so the pass only runs where that yield does not exist.

**Where it runs:** inside a `warp` proc, and in `uninterrupted` code whose loop touches only `confined` state. A warp loop never yields, so unrolling it changes nothing a script can observe. A loop in a script or a non-warp proc yields every iteration; other scripts can run in between, and a script that polls a variable the loop updates (`wait until [x] = 5`) would see different values once the yields are gone. (Returning procs are `warp`, and inlining brings small warp bodies into warp callers, so this covers a good share of real loops.)

**Outside `warp`** the pass needs two whole-program facts from the client (see `confined` and `uninterrupted` in `ir.md`). It unrolls a loop in an `uninterrupted` script or proc when every variable and list the body reads or writes is `confined` (a counted `for` also needs its internal iterator marked `confined`), and the body has no `sb`, `call`, `wait`, `wait.until`, `broadcast`, `broadcast.wait`, `stop` or monitor op. Then no other thread can see the intermediate values, and none can stop or restart the loop halfway. What does change is the scheduling: the loop finishes in one scheduler step instead of one per iteration, so the code after it runs earlier relative to other scripts. That is the trade-off section 4 describes, made with an analysis instead of a flag. Scratchpiler only supplies the facts when its project analysis covers every sprite and found no `__asm__`.

**What it unrolls:**

- `repeat n` with a literal `n`. The trip count is `round(n)`, as in Scratch, and a count of zero or less removes the loop.
- The loop `irgen` emits for `for [i] from a to b`: `var.set @i, a`, then `until { i > b } do { … } step { var.change @i, 1 }`, with `a` and `b` integer literals and `@i` an `internal` variable that the body never writes. The trip count is `b - a + 1`, or zero. Reads of `@i` in the body become the literal for that iteration, so `constfold` can fold `i * 10` into a constant, and the initialization of `@i` is dropped because nothing can read it afterwards.

**What it refuses:** a `nounroll` loop; more than 16 trips; a body that makes the unrolled code larger than 40 ops; a loop whose body contains `break` or `continue` for that loop (nested loops may use their own); a body that always ends the proc (`ret` as its last op); a `for` loop with non-literal or fractional bounds, a user-visible iterator, or a body that assigns the iterator.

**Copies:** each copy is a fresh clone with new value names. Waits, calls and conditional `ret`s stay in every copy. Inner loops are unrolled first, so an outer loop is judged by its already-expanded size.

**Checked by:** `test/unroll.test.js` (what unrolls, each refusal, and eager/tree equivalence), the generic example tests (`examples/unroll.sl` also runs in the real scratch-vm), and Scratchpiler's differential fuzzer with its `warpLoops` feature, which puts constant-count loops into warp and returning procs.

**Checked by (non-warp):** `test/confinement.test.js`, and Scratchpiler's `tests/project-compile.test.js`, which compiles programs with facts from a real project analysis and runs them in scratch-vm.

**Not done:** partial unrolling of loops with a variable trip count, and unrolling `while`/`until` loops.

## 1c. Effect summaries and unused calls

**Done:** `summarize` in `src/passes/effects.js`; consumers are `dce` and `unroll`.

`call` is typed `yield` in the op table, which is the worst case, so a call could never be deleted or moved. `summarize(target)` now computes per proc (and closes over everything the proc can reach):

| Field | Meaning |
|---|---|
| `writes`, `reads` | variable and list keys (`var:x`, `list:l`), `world` for `sb`, and `*` for an extern proc. `reads` is new. |
| `explicitYield` | contains `wait`, `broadcast.wait`, `sb` yielders (and so on); not counting loops or calls |
| `world` | contains `sb`, `broadcast`, `wait`, a monitor op or a `stop` other than `stop "this script"`: anything observable beyond variables and lists |
| `diverges` | contains `forever`, `until` or `wait.until`, or is recursive. (`repeat` always ends.) |

Two things use them today:

- **`dce` deletes an unused call** when the callee is *discardable*: not extern, no writes, no `world`, no explicit yield, does not diverge, and the call itself does not yield in this context (the callee is `warp`, or the caller is). Reads are fine, since nothing can observe a read. A returning proc whose result nobody uses, such as `set [x] to f(2)` after `x` was overwritten, disappears with its whole body of work. This relies on `ret` still being a `ret`: after `lower-ret` the callee writes its `@__ret_f` variable and is no longer discardable, so run `dce` before `legalize` (`-O1` does).
- **`unroll` accepts calls** in the body of a loop it unrolls outside `warp`: the callee must be `warp` (so the call does not yield), have no explicit yield and no `world`, and read and write only `confined` variables and lists. Before this, any `call` made the loop ineligible.

**Not done:** treating a discardable call as `pure`/`read` in `spill` and CSE, hoisting a pure call out of a loop, and reporting the summaries from `slopt` for debugging.

## 1d. Counted `for` → `repeat` (`indvars`)

**Done:** `src/passes/indvars.js`, run by `-p indvars` or inside `-p O1`, before `unroll`.

`irgen` emits `for [i] from a to b` as `var.set @i, a` followed by `until { i > b } do { … } step { change @i, 1 }`. Each iteration then pays for a `var.get`, a `gt` and a `var.change` that a `repeat` does not need. When nothing reads `@i`, the loop becomes `repeat (b - a + 1)`:

```
var.set @i, 1                           %n = list.len @items
until { gt (var.get @i), %n } do {  →   repeat %n {
  …                                       …
} step { change @i, 1 }                 }
```

It applies when:

- the iterator is `internal`, is read nowhere in the module except the loop's own condition, and the body never writes it;
- the start and the end are **provably finite integers**: integer literals, `list.len`, `length`, `list.index`, and `add`/`sub` of those. This is deliberately narrow. `i > b` compares as text when `b` is not numeric (`"abc"`, `""`), while `repeat` would run zero times, so the rewrite is only sound when `b` cannot be such a value. A `var.get` or an argument is not known to be numeric, so `for [i] from 1 to [n]` is **not** converted. That is what a kind lattice (known number / known integer) would unlock, see below;
- the end is invariant: the ops computing it only read, nothing in the body or the callees writes what they read, and if they read shared state the loop cannot yield (a `warp` context with no waits or yielding calls). A `list.len` of a `confined` list is fine anywhere.

The count is built from the pieces: `from` and `to` literal gives a literal, `to = len - 1` from `0` gives `repeat len` (the offsets are folded exactly, since both sides are integers), otherwise one `add` or `sub`. `break` and `continue` mean the same in the `repeat`. `nounroll` and the metadata tag follow the loop.

**Checked by:** `test/indvars.test.js` (conversion, every refusal, trip counts including empty and negative ranges, nested loops, `break`/`continue`, equivalence in eager and tree mode) and the differential fuzzer.

**Measured:** a 100-iteration counted loop plus a list-length loop go from 430 to 110 dynamic blocks (`-O1` before and after). Counted loops whose iterator is used in the body, the common case, are unchanged.

## 2. Copy propagation and dead stores

**Partly done:** `src/passes/dse.js` (`-p dse`, inside `-O1` after `unroll`) and `src/passes/dead-vars.js` (`-p dead-vars`, opt-in).

Legalization leaves predictable residue: `var.set @t, x` followed by a single `var.get @t`, flag variables that are set and never read on some path, `__ret` writes whose only reader was inlined away.

### What `dse` does

`dse` scans each region as straight-line code, remembering the last pending store to each variable. This is where the roadmap's "writes to user variables are never dead" was too strict: between two stores to a variable, with no read of it and no yield, no other script and no monitor redraw can observe the first one, so it is dead **even for a shared user variable**. Inside one span:

| Pattern | Result |
|---|---|
| `set x, a; set x, b` | `set x, b` |
| `set x, 1; change x, 2` | `set x, 3`, computed with the same cast and addition as the VM |
| `change x, %v; set x, 9` | both deleted, because the `change` only fed the overwritten store |
| `set x, 5; %t = get x` | `%t` becomes the literal `5`, and `constfold` rules apply immediately (the pass runs `foldValue` as it substitutes) |
| `change x, 1; change x, 1` | **kept.** `(x+1)+1` and `x+2` differ in the last bit for some fractional or huge `x`. Merging needs `x` known to be a small integer |

A span ends, and the pending stores survive, at: a read of that variable that cannot be resolved; any op with regions (`if`, loops); a `call` whose callee reads or writes the variable, does something to the `world` or is extern; a `sb` or other op that may end the script (`delete this clone`, `stop`) or observe state (`sensing_of` can read another sprite's variable). A `call` or `wait` that yields ends the span for variables that are not `internal` or `confined`. The `cloud` flag does not exist in the IR, so a cloud variable's intermediate update is dropped as well, which the cloud server cannot tell apart from rate limiting.

**Not done:** forwarding a non-literal stored value (extending an SSA value's lifetime is a tree-safety question for `spill`), spans through `if` arms that do not touch the variable, and the flag folding after `lower-break`.

### `dead-vars`

Deletes `set`/`change` on an `internal` variable and `list.add`/`del`/`ins`/`set`/`clear` on an `internal` list that nothing in the module reads (no `get`, `len`, `list.contents`, monitor op, or hat region). **Opt-in**, not part of `-O1`: the only thing it finds before legalization is a hidden `pyfor` item that the body ignores, and removing that store makes Pull from Scratch show a counted `for` instead of `pyfor`, because the decompiler recognizes the loop by that store. It is worth turning on after `legalize` for `__ret_f` variables whose callers were inlined, once the decompiler question is settled.

- **Store-to-load forwarding:** replace `var.get @t` with the stored value when the clobber check passes over the interval between them. This is the same machinery as `spill`, run in reverse.
- **`dse`:** delete a `var.set` to an `internal` variable that no later read can observe. **Never** for user variables: monitors, other sprites, clones and cloud variables can all see them.
- **Flag folding** after `lower-break`: a guard `if (brk = 0)` placed right after an op that cannot set `brk` on any path is always true.

## 3. Scratch idiom peepholes

Small rewrites that know Scratch better than a generic optimizer would:

| Pattern | Rewrite | Why |
|---|---|---|
| `list.get @l, (list.len @l)` | `list.get @l, "last"` | scratch-vm understands `"last"`, which saves a block and a length lookup. The IR and `cast.js` need to model `"last"`/`"random"` indices first |
| `eq (var.get @f), "true"` for `rotate-cond` flags | store `1`/`0` and test `= 1` | no string comparison |
| `not (lt a, b)` from `repeat` → `until` | `gt` plus an off-by-one adjustment, only when `b` is known to be an integer | one fewer block per iteration |
| `join a, ""` | `a`, only in text slots | `join` always produces a string; a number slot would see a number instead |
| `join "a", (join "b", x)` and `join (join x, "a"), "b"` | `join "ab", x` | **done** in `constfold`. String concatenation is associative and `join` casts both sides to text, so this is exact. It halves the blocks of an interpolated string once a variable's value was forwarded. The inner `join` stays if something else uses it |

Each peephole needs a Scratch-semantics proof, written next to it in `cast.js` terms.

## 4. Loop outlining and limited `warp` inference (`-O2`, opt-in)

`warp` only applies to procs, so making a script-level loop atomic means **outlining** it into a new `warp` proc and calling it. Given the measurement above, this pays off when the work exceeds the frame budget, and it is only legal when:

- the loop body cannot request a redraw (no motion/looks/pen/sound `sb` ops), so the user would see no difference, and
- the loop has no explicit yields (`wait`, `ask`, `*forsecs`, `glide`, `broadcast.wait`), and
- **nothing else in the project can observe the intermediate state.** That needs the event-graph analysis below: no other script can read the variables the loop writes while the loop runs. Scratch's scheduler is deterministic, and projects do depend on how scripts interleave.

Because the last condition is hard to prove, this belongs behind an explicit flag (`-O2 --assume-no-races`), not on by default. scratch-vm stops a `warp` proc after 500 ms anyway, which limits the damage if the analysis is wrong.

## 5. Event-graph analysis

**Partly done, in Scratchpiler** (`src/project-analysis.js`), because it needs every sprite's source and SLVM only sees one sprite at a time. It reaches SLVM as the `confined` and `uninterrupted` attributes, which the unroller and `spill` use. The broadcast-as-goto lint below is still open.

A module-level analysis: which broadcasts start which scripts; which variables each script reads and writes, and where it yields; how clones affect sprite-local state. This analysis:

- provides the race checks that `-O2` needs;
- makes `spill`'s yield rule more precise: a read of a user variable only needs spilling across a yield if some *other* script writes that variable (**done** for `confined` variables);
- detects broadcast-as-goto chains like `spaghetti-goto.sdsl`, where the only receiver of `broadcast X` is a script whose last op broadcasts again. These could become a loop, but that changes thread identity and timing, so it should be reported as a lint rather than rewritten;
- finds scripts that can never start (a `receive` hat that nothing broadcasts), for a dead-script lint (**done**, as a Scratchpiler editor check).

## 6. Low priority: CSE, GVN, LICM

These are standard in LLVM and mostly **unprofitable** here. Emitting values as trees means recomputing a value is free in static terms (it's just a copy of the same blocks); the only alternative is a spill, which costs a `set` block plus a `get` block per use and an extra variable in the palette. CSE only pays off when the shared tree is large *and* the value is used many times, for example a long `join` chain inside a loop. LICM has the same trade-off, plus the yield rule for reads. Gate both on the cost model from step 0 and only apply them when it predicts a net reduction in dynamic blocks.

---

## Pipelines

| Level | Passes |
|---|---|
| `-O0` | `legalize` |
| `-O1` | `inline`, `constfold`, `indvars`, `unroll`, `constfold`, `dse`, `constfold`, `dce`, then `legalize`; non-literal forwarding and the remaining peepholes are still planned |
| `-O2` | `-O1` + loop outlining/`warp` (needs `--assume-no-races` until the event-graph analysis lands) |
| `-Os` | `-O1` plus outlining repeated statement sequences into procs; trades dynamic blocks for fewer blocks to scroll past |

Every level reruns `verify` after each pass (already the default in `runPipeline`), and every new pass gets a fuzzer run that compares against the real scratch-vm before it is turned on by default.

**What `indvars`, `dse` and the effect summaries bought on the fuzzer** (3,000 programs, same seeds, blocks emitted by Scratchpiler's `-O1`): 1,031,954 → 977,411 (-5.3%); with `warpLoops` 916,698 → 874,653 (-4.6%); with `warpLoops` and project facts 908,695 → 872,707 (-4.0%). 12,000 programs across these configurations matched the source oracle with no mismatches. The fuzzer's loops mostly use their iterator, so the loop conversion contributes little there; most of it is `dse` and join merging.

## Next

- **A value-kind lattice** (known number, known integer, known non-negative, known bool). It is the missing piece for `for [i] from 1 to [n]`, for `x + 0` and `x * 1`, for merging `change x, 1; change x, 1`, and for `not (lt a b)` → `gt`. The rule that makes it sound: results of arithmetic ops are numbers but can be `NaN` or `Infinity`, which compare as text; only `round`, `length`, `list.len`, `list.index` and integer literals are known finite.
- Tail recursion to a loop, break-to-condition fusion, spill coalescing, and dead-argument elimination, in roughly that order.
