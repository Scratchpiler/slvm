import { walk } from '../ir.js';
import { effectOf } from '../ops.js';

export const ANYTHING = '*';
export const WORLD = 'world';
export const LOOP_OPS = new Set(['repeat', 'forever', 'until', 'wait.until']);

const LIST_READS = new Set(['list.get', 'list.len', 'list.has', 'list.index']);
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

export function summarize(target) {
    const summaries = new Map();
    for (const proc of target.procs) {
        const s = { proc, writes: new Set(), callees: new Set(), explicitYield: false, reaches: new Set() };
        walk(proc.body, (op) => {
            for (const w of ownWrites(op)) s.writes.add(w);
            if (op.op === 'call') s.callees.add(op.callee);
            if (EXPLICIT_YIELDS(op)) s.explicitYield = true;
        });
        summaries.set(proc.name, s);
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
            s.explicitYield ||= other.explicitYield;
        }
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
