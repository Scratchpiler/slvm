import { roots, walk, lookupVar } from '../ir.js';
import { directReads } from './effects.js';

const DISPLAY_OPS = new Set(['var.show', 'var.hide', 'list.show', 'list.hide']);
const LIST_WRITES = new Set(['list.add', 'list.del', 'list.ins', 'list.set', 'list.clear']);

function readKeys(mod) {
    const keys = new Set();
    const note = (op) => {
        if (op.op !== 'call') for (const k of directReads(op)) keys.add(k);
        if (DISPLAY_OPS.has(op.op)) keys.add(`${op.op.startsWith('var') ? 'var' : 'list'}:${op.args[0].sym}`);
    };
    for (const root of roots(mod)) walk(root.body, note);
    for (const target of mod.targets) {
        for (const script of target.scripts) if (script.hat.with) walk(script.hat.with, note);
    }
    return keys;
}

export function deadVars(mod) {
    const reads = readKeys(mod);
    const isUnread = (target, op) => {
        const kind = op.op.startsWith('var.') ? 'var' : 'list';
        const name = op.args[0].sym;
        return !reads.has(`${kind}:${name}`) && !!lookupVar(mod, target, name, kind)?.internal;
    };
    const writes = (op) => op.op === 'var.set' || op.op === 'var.change' || LIST_WRITES.has(op.op);
    const sweep = (target, region) => region
        .filter((op) => !(writes(op) && isUnread(target, op)))
        .map((op) => { op.regions = op.regions.map((r) => sweep(target, r)); return op; });
    for (const root of roots(mod)) {
        const holder = root.proc ?? root.script;
        holder.body = sweep(root.target, holder.body);
    }
    return mod;
}
