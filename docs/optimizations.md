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

- **`slc --stats`**: static block counts, plus dynamic counts from the interpreter in tree mode (count every op it evaluates). That is exactly the number of blocks scratch-vm would dispatch.
- **Frames with a redraw model**: `test/scratch-vm.js` currently has no renderer, so nothing ever requests a redraw. A stub that calls `runtime.requestRedraw()` from the blocks that would draw (motion, looks, pen) would make the frame counts realistic.
- **A random program generator.** Structured IR is easy to generate: nested `if`/`repeat`/`until`, arithmetic on a few variables, procs with `ret`, `break`/`continue`, recursion with bounded depth. Every generated program runs through every pipeline (`legalize`, and `O1`/`O2` once those exist), and three results must agree: the interpreter in eager mode before, the interpreter in tree mode after, and the real scratch-vm after.

The fuzzer is the single best investment. Every bug found while building legalization and `slc` showed up as a disagreement between two of these runs: the `forever`-with-`break` terminator, spill re-iterating a list it was editing, `sayforsecs` running on real timers, undeclared variables missing from the interpreter's results.

---

## 1. Inlining returning procs, then folding (`-O1`)

**The biggest structural win.** Every `define ... returns` call costs a `procedures_call`, a `var.set @__ret_f`, a `stop`, a `var.get @__ret_f`, and sometimes a spill. Inlining a small non-recursive returning proc into its caller removes all of that:

```
%0 = call @rectArea(6, 7)        →        %0 = mul 6, 7        →        42
```

**When it's legal:**
- The callee is not recursive (`summarize` already computes `reaches`).
- `ret` turns into structured control flow: a single `ret` at the end becomes the value. Early `ret`s become an `if`/`else` chain, or are left alone (don't inline).
- `warp`: inlining a warp callee into a non-warp caller removes the callee's atomicity, so loops in the inlined body would now yield once per iteration. Only inline warp callees that have no loops and no yields.
- Arguments: `arg n` becomes the caller's operand. Pure operands can be substituted directly. Reads need the same clobber check `spill` uses, because the callee's body could write what the argument reads before it is used.

After inlining, `constfold` + `dce` remove the leftovers, and `spill` usually has nothing left to do.

**Evidence needed:** the fuzzer, and a dynamic block count drop on `return-functions.sl`. That example should shrink to a handful of blocks.

## 2. Copy propagation and dead stores on internal variables

Legalization leaves predictable residue: `var.set @t, x` followed by a single `var.get @t`, flag variables that are set and never read on some path, `__ret` writes whose only reader was inlined away.

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

Each peephole needs a Scratch-semantics proof, written next to it in `cast.js` terms.

## 4. Loop outlining and limited `warp` inference (`-O2`, opt-in)

`warp` only applies to procs, so making a script-level loop atomic means **outlining** it into a new `warp` proc and calling it. Given the measurement above, this pays off when the work exceeds the frame budget, and it is only legal when:

- the loop body cannot request a redraw (no motion/looks/pen/sound `sb` ops), so the user would see no difference, and
- the loop has no explicit yields (`wait`, `ask`, `*forsecs`, `glide`, `broadcast.wait`), and
- **nothing else in the project can observe the intermediate state.** That needs the event-graph analysis below: no other script can read the variables the loop writes while the loop runs. Scratch's scheduler is deterministic, and projects do depend on how scripts interleave.

Because the last condition is hard to prove, this belongs behind an explicit flag (`-O2 --assume-no-races`), not on by default. scratch-vm stops a `warp` proc after 500 ms anyway, which limits the damage if the analysis is wrong.

## 5. Event-graph analysis

A module-level analysis: which broadcasts start which scripts; which variables each script reads and writes, and where it yields; how clones affect sprite-local state. This analysis:

- provides the race checks that `-O2` needs;
- makes `spill`'s yield rule more precise: a read of a user variable only needs spilling across a yield if some *other* script writes that variable;
- detects broadcast-as-goto chains like `spaghetti-goto.sdsl`, where the only receiver of `broadcast X` is a script whose last op broadcasts again. These could become a loop, but that changes thread identity and timing, so it should be reported as a lint rather than rewritten;
- finds scripts that can never start (a `receive` hat that nothing broadcasts), for a dead-script lint.

## 6. Low priority: CSE, GVN, LICM

These are standard in LLVM and mostly **unprofitable** here. Emitting values as trees means recomputing a value is free in static terms (it's just a copy of the same blocks); the only alternative is a spill, which costs a `set` block plus a `get` block per use and an extra variable in the palette. CSE only pays off when the shared tree is large *and* the value is used many times, for example a long `join` chain inside a loop. LICM has the same trade-off, plus the yield rule for reads. Gate both on the cost model from step 0 and only apply them when it predicts a net reduction in dynamic blocks.

---

## Pipelines

| Level | Passes |
|---|---|
| `-O0` | `legalize` |
| `-O1` | `inline`, `constfold`, `dce`, copy propagation, `dse`, peepholes, then `legalize` |
| `-O2` | `-O1` + loop outlining/`warp` (needs `--assume-no-races` until the event-graph analysis lands) |
| `-Os` | `-O1` plus outlining repeated statement sequences into procs; trades dynamic blocks for fewer blocks to scroll past |

Every level reruns `verify` after each pass (already the default in `runPipeline`), and every new pass gets a fuzzer run that compares against the real scratch-vm before it is turned on by default.
