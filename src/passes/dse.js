import { roots, lookupVar, lit } from '../ir.js';
import { EVAL } from '../cast.js';
import { effectOf } from '../ops.js';
import { foldValue } from './constfold.js';
import { summarize, yieldsAt, ANYTHING } from './effects.js';

const LIST_OPS = new Set(['list.get', 'list.len', 'list.has', 'list.index', 'list.contents', 'list.add', 'list.del', 'list.ins', 'list.set', 'list.clear']);
const DISPLAY_OPS = new Set(['var.show', 'var.hide', 'list.show', 'list.hide']);

const isLit = (a) => a.lit !== undefined;

const isNeutral = (op) => !op.regions.length && (effectOf(op) === 'pure' || op.op === 'random' || LIST_OPS.has(op.op) || DISPLAY_OPS.has(op.op));

function forgetFor(op, pending, ctx) {
    const clear = (keep) => { for (const name of [...pending.keys()]) if (!keep(name)) pending.delete(name); };
    if (op.op === 'call') {
        const s = ctx.summaries.get(op.callee);
        if (!s || s.world || s.reads.has(ANYTHING) || s.writes.has(ANYTHING)) return clear(() => false);
        const yields = yieldsAt(op, ctx);
        return clear((name) => !s.reads.has(`var:${name}`) && !s.writes.has(`var:${name}`) && !(yields && ctx.volatile(name)));
    }
    if (op.op === 'sb' && op.result !== null) return clear((name) => !ctx.volatile(name));
    return clear(() => false);
}

function process(region, ctx) {
    const out = [];
    const dead = new Set();
    const pending = new Map();
    const kill = (entry) => { dead.add(entry.op); entry.chain.forEach((o) => dead.add(o)); };
    const substitute = (a) => (a.ref !== undefined && ctx.env.has(a.ref) ? ctx.env.get(a.ref) : a);

    for (const op of region) {
        op.args = op.args.map(substitute);
        const folded = op.result !== null ? foldValue(op, ctx.defs) : undefined;
        if (folded !== undefined) {
            ctx.env.set(op.result, folded);
            continue;
        }
        if (op.result !== null) ctx.defs.set(op.result, op);

        if (op.op === 'var.get') {
            const entry = pending.get(op.args[0].sym);
            if (entry?.known) {
                ctx.env.set(op.result, lit(entry.value));
                continue;
            }
            pending.delete(op.args[0].sym);
        } else if (op.op === 'var.set') {
            const name = op.args[0].sym;
            const previous = pending.get(name);
            if (previous) kill(previous);
            const [, value] = op.args;
            pending.set(name, { op, known: isLit(value), value: value.lit, chain: [] });
        } else if (op.op === 'var.change') {
            const name = op.args[0].sym;
            const previous = pending.get(name);
            const [, amount] = op.args;
            const sum = previous?.known && isLit(amount) ? EVAL.add(previous.value, amount.lit) : NaN;
            if (Number.isFinite(sum)) {
                kill(previous);
                op.op = 'var.set';
                op.args = [op.args[0], lit(sum)];
                pending.set(name, { op, known: true, value: sum, chain: [] });
            } else {
                pending.set(name, { op, known: false, chain: previous ? [previous.op, ...previous.chain] : [] });
            }
        } else if (op.regions.length) {
            op.regions = op.regions.map((r) => process(r, ctx));
            pending.clear();
        } else if (!isNeutral(op)) {
            forgetFor(op, pending, ctx);
        }
        out.push(op);
    }
    return out.filter((op) => !dead.has(op));
}

export function dse(mod) {
    const summaries = new Map(mod.targets.map((target) => [target, summarize(target)]));
    for (const root of roots(mod)) {
        const holder = root.proc ?? root.script;
        const ctx = {
            mod,
            target: root.target,
            warp: !!root.proc?.warp,
            summaries: summaries.get(root.target),
            env: new Map(),
            defs: new Map(),
            volatile: (name) => {
                const decl = lookupVar(mod, root.target, name, 'var');
                return !decl?.internal && !decl?.confined;
            },
        };
        holder.body = process(holder.body, ctx);
    }
    return mod;
}
