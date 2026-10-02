import { EVAL, toNumber } from '../cast.js';
import { OPS, isTerminator, EFFECT_RANK, effectOf } from '../ops.js';
import { roots } from '../ir.js';

const isLit = (a) => a.lit !== undefined;
const lit = (v) => ({ lit: v });

function foldValue(op, defs) {
    if (!(op.op in EVAL) || OPS[op.op].effect !== 'pure') return undefined;
    const [a, b] = op.args;
    if (op.args.every(isLit)) {
        const v = EVAL[op.op](...op.args.map((x) => x.lit));
        return typeof v === 'number' && !Number.isFinite(v) ? undefined : lit(v);
    }
    switch (op.op) {
        case 'and':
            if (isLit(a)) return a.lit ? b : lit(false);
            if (isLit(b)) return b.lit ? a : lit(false);
            break;
        case 'or':
            if (isLit(a)) return a.lit ? lit(true) : b;
            if (isLit(b)) return b.lit ? lit(true) : a;
            break;
        case 'not': {
            const inner = a.ref !== undefined && defs.get(a.ref);
            if (inner?.op === 'not') return inner.args[0];
            break;
        }
    }
    return undefined;
}

const sideEffectFree = (ops) => ops.every((o) => o.op === 'cond' || EFFECT_RANK[effectOf(o)] <= EFFECT_RANK.read);

function foldControl(op) {
    switch (op.op) {
        case 'if': {
            const [c] = op.args;
            if (isLit(c)) return c.lit ? op.regions[0] : op.regions[1] ?? [];
            if (op.regions.every((r) => r.length === 0)) return [];
            if (op.regions[1]?.length === 0) op.regions.pop();
            break;
        }
        case 'repeat': {
            const [n] = op.args;
            if (isLit(n) && Math.round(toNumber(n.lit)) <= 0) return [];
            break;
        }
        case 'until':
        case 'wait.until': {
            const condRegion = op.regions[0];
            const c = condRegion.at(-1).args[0];
            if (isLit(c) && c.lit === true) {
                const pre = condRegion.slice(0, -1);
                return sideEffectFree(pre) ? [] : pre;
            }
            break;
        }
    }
    return null;
}

function foldRegion(region, env, defs) {
    const out = [];
    for (const op of region) {
        op.args = op.args.map((a) => (a.ref !== undefined && env.has(a.ref) ? env.get(a.ref) : a));
        op.regions = op.regions.map((r) => foldRegion(r, env, defs));

        const value = foldValue(op, defs);
        if (value !== undefined) {
            env.set(op.result, value);
            continue;
        }
        if (op.result !== null) defs.set(op.result, op);

        const replacement = foldControl(op);
        const emitted = replacement ?? [op];
        let terminated = false;
        for (const e of emitted) {
            out.push(e);
            if (isTerminator(e)) { terminated = true; break; }
        }
        if (terminated) break;
    }
    return out;
}

export function constfold(mod) {
    for (const root of roots(mod)) {
        const holder = root.proc ?? root.script;
        holder.body = foldRegion(holder.body, new Map(), new Map());
    }
    return mod;
}
