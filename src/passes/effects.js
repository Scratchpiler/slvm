import { walk, lookupVar } from '../ir.js';
import { effectOf } from '../ops.js';

export const ANYTHING = '*';
export const WORLD = 'world';
export const LOOP_OPS = new Set(['repeat', 'forever', 'until', 'wait.until']);

const LIST_READS = new Set(['list.get', 'list.len', 'list.has', 'list.index', 'list.contents']);
const LIST_WRITES = new Set(['list.add', 'list.del', 'list.ins', 'list.set', 'list.clear']);

export function directReads(op) {
    if (op.op === 'var.get') return [`var:${op.args[0].sym}`];
    if (LIST_READS.has(op.op)) return [`list:${op.args[0].sym}`];
    if (op.op === 'sb' && op.result !== null) return [WORLD];
    if (op.op === 'call' && op.result !== null) return [ANYTHING];
    return [];
}

function ownWrites(op) {
    if (op.op === 'var.set' || op.op === 'var.change') return [`var:${op.args[0].sym}`];
    if (LIST_WRITES.has(op.op)) return [`list:${op.args[0].sym}`];
    if (op.op === 'sb' && op.result === null) return [WORLD];
    return [];
}

const EXPLICIT_YIELDS = (op) => effectOf(op) === 'yield' && op.op !== 'call' && !LOOP_OPS.has(op.op);

const WORLD_OPS = new Set(['sb', 'broadcast', 'broadcast.wait', 'wait', 'wait.until', 'var.show', 'var.hide', 'list.show', 'list.hide']);
const DIVERGING_LOOPS = new Set(['forever', 'until', 'wait.until']);

const touchesWorld = (op) => WORLD_OPS.has(op.op) || (op.op === 'stop' && op.args[0].lit !== 'this script');

function procFacts(proc) {
    const facts = {
        writes: new Set(proc.extern ? [ANYTHING] : []),
        reads: new Set(proc.extern ? [ANYTHING] : []),
        callees: new Set(),
        explicitYield: !!proc.extern,
        world: !!proc.extern,
        diverges: !!proc.extern,
    };
    walk(proc.body, (op) => {
        for (const w of ownWrites(op)) facts.writes.add(w);
        if (op.op !== 'call') for (const r of directReads(op)) facts.reads.add(r);
        if (op.op === 'call') facts.callees.add(op.callee);
        if (EXPLICIT_YIELDS(op)) facts.explicitYield = true;
        if (touchesWorld(op)) facts.world = true;
        if (DIVERGING_LOOPS.has(op.op)) facts.diverges = true;
    });
    return facts;
}

export function summarize(target, cache = null) {
    const summaries = new Map();
    for (const proc of target.procs) {
        let facts = cache?.get(proc);
        if (!facts) {
            facts = procFacts(proc);
            cache?.set(proc, facts);
        }
        summaries.set(proc.name, {
            ...facts,
            proc,
            writes: new Set(facts.writes),
            reads: new Set(facts.reads),
            reaches: new Set(),
        });
    }
    for (const s of summaries.values()) {
        const stack = [...s.callees];
        while (stack.length) {
            const name = stack.pop();
            if (s.reaches.has(name) || !summaries.has(name)) continue;
            s.reaches.add(name);
            stack.push(...summaries.get(name).callees);
        }
    }
    for (const s of summaries.values()) {
        for (const name of s.reaches) {
            const other = summaries.get(name);
            for (const w of other.writes) s.writes.add(w);
            for (const r of other.reads) s.reads.add(r);
            s.explicitYield ||= other.explicitYield;
            s.world ||= other.world;
            s.diverges ||= other.diverges;
        }
        if (s.reaches.has(s.proc.name)) s.diverges = true;
    }
    return summaries;
}

const FLAGS = ['explicitYield', 'world', 'diverges'];
const added = (before, after) => [...after].filter((key) => !before.has(key));
const covers = (after, before) => [...before].every((key) => after.has(key));

export function resummarize(summaries, target, proc, cache) {
    const before = cache.get(proc);
    const after = procFacts(proc);
    cache.set(proc, after);
    const onlyGrew = before
        && summaries.get(proc.name)?.proc === proc
        && FLAGS.every((flag) => before[flag] === after[flag])
        && before.callees.size === after.callees.size && covers(after.callees, before.callees)
        && covers(after.writes, before.writes) && covers(after.reads, before.reads);
    if (!onlyGrew) return summarize(target, cache);
    const writes = added(before.writes, after.writes);
    const reads = added(before.reads, after.reads);
    if (!writes.length && !reads.length) return summaries;
    for (const s of summaries.values()) {
        if (s.proc !== proc && !s.reaches.has(proc.name)) continue;
        for (const w of writes) s.writes.add(w);
        for (const r of reads) s.reads.add(r);
    }
    return summaries;
}

export function writesOf(op, summaries) {
    if (op.op === 'call') {
        const s = summaries.get(op.callee);
        if (!s) return [ANYTHING];
        return [...s.writes, ...[...s.reaches, op.callee].map((p) => `proc:${p}`)];
    }
    return ownWrites(op);
}

export function yieldsAt(op, { warp, summaries }) {
    if (LOOP_OPS.has(op.op)) return op.op === 'wait.until' || !warp;
    if (op.op === 'call') {
        const s = summaries.get(op.callee);
        if (!s) return true;
        return s.explicitYield || (!warp && !s.proc.warp);
    }
    return EXPLICIT_YIELDS(op);
}

const isConfinedKey = (key, ctx) => {
    const colon = key.indexOf(':');
    return !!lookupVar(ctx.mod, ctx.target, key.slice(colon + 1), key.slice(0, colon))?.confined;
};

export function isDiscardable(op, ctx) {
    const s = ctx.summaries.get(op.callee);
    return !!s && s.writes.size === 0 && !s.world && !s.explicitYield && !s.diverges && !yieldsAt(op, ctx);
}

export function isIsolatedCall(op, ctx) {
    const s = ctx.summaries.get(op.callee);
    if (!s || s.world || s.explicitYield || !s.proc.warp) return false;
    return [...s.reads, ...s.writes].every((key) => key !== ANYTHING && key !== WORLD && isConfinedKey(key, ctx));
}
