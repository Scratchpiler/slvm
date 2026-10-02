import { EVAL, toNumber, toBoolean, toString, compare } from './cast.js';
import { lookupVar } from './ir.js';

export class StepLimitExceeded extends Error {}

class StopSignal { constructor(kind) { this.kind = kind; } }
class ReturnSignal { constructor(value) { this.value = value; } }
class BreakSignal {}
class ContinueSignal {}

function lcg(seed) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

export function run(mod, { event = 'flag', tree = false, maxSteps = 1e6, seed = 1 } = {}) {
    const store = new Map();
    const trace = [];
    const rand = lcg(seed);
    let steps = 0;

    const decl = (frame, name, kind) => {
        const d = lookupVar(mod, frame.target, name, kind);
        if (!d) throw new Error(`undeclared ${kind} @${name}`);
        if (!store.has(d)) store.set(d, kind === 'list' ? [] : 0);
        return d;
    };
    const getVar = (f, name) => store.get(decl(f, name, 'var'));
    const setVar = (f, name, v) => store.set(decl(f, name, 'var'), v);
    const list = (f, name) => store.get(decl(f, name, 'list'));
    const listIndex = (l, i) => Math.floor(toNumber(i)) - 1;

    function value(a, frame) {
        if (a.lit !== undefined) return a.lit;
        if (a.ref === undefined) throw new Error('operand is not a value');
        if (tree && frame.defs.has(a.ref)) return evaluate(frame.defs.get(a.ref), frame);
        if (!frame.values.has(a.ref)) throw new Error(`%${a.ref} has no value`);
        return frame.values.get(a.ref);
    }

    function evaluate(op, frame) {
        const v = (i) => value(op.args[i], frame);
        if (op.op in EVAL) return EVAL[op.op](...op.args.map((_, i) => v(i)));
        switch (op.op) {
            case 'arg':
            case 'arg.b':
                return frame.args.get(op.args[0].name);
            case 'random': {
                const lo = toNumber(v(0));
                const hi = toNumber(v(1));
                const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
                if (Number.isInteger(a) && Number.isInteger(b)) return a + Math.floor(rand() * (b - a + 1));
                return a + rand() * (b - a);
            }
            case 'var.get': return getVar(frame, op.args[0].sym);
            case 'list.get': {
                const l = list(frame, op.args[0].sym);
                return l[listIndex(l, v(1))] ?? '';
            }
            case 'list.len': return list(frame, op.args[0].sym).length;
            case 'list.has': return list(frame, op.args[0].sym).some((x) => compare(x, v(1)) === 0);
            case 'list.index': return list(frame, op.args[0].sym).findIndex((x) => compare(x, v(1)) === 0) + 1;
            case 'sb': return 0;
            case 'call': return call(op, frame);
        }
        throw new Error(`cannot evaluate \`${op.op}\``);
    }

    function call(op, frame) {
        const proc = frame.target.procs.find((p) => p.name === op.callee);
        const args = new Map(proc.params.map((p, i) => [p, value(op.args[i], frame)]));
        const inner = { target: frame.target, args, values: new Map(), defs: new Map() };
        try {
            execRegion(proc.body, inner);
        } catch (e) {
            if (e instanceof ReturnSignal) return e.value;
            if (!(e instanceof StopSignal && e.kind === 'this script')) throw e;
        }
        return '';
    }

    function condition(region, frame) {
        execRegion(region.slice(0, -1), frame);
        return toBoolean(value(region.at(-1).args[0], frame));
    }

    function loopBody(region, frame) {
        try {
            execRegion(region, frame);
        } catch (e) {
            if (e instanceof BreakSignal) return false;
            if (!(e instanceof ContinueSignal)) throw e;
        }
        return true;
    }

    function exec(op, frame) {
        if (++steps > maxSteps) throw new StepLimitExceeded(`more than ${maxSteps} steps`);
        const v = (i) => value(op.args[i], frame);
        const name = op.args[0]?.sym;

        if (op.result !== null) {
            if (tree && op.op !== 'call') frame.defs.set(op.result, op);
            else frame.values.set(op.result, evaluate(op, frame));
            return;
        }
        switch (op.op) {
            case 'var.set': return setVar(frame, name, v(1));
            case 'var.change': return setVar(frame, name, toNumber(getVar(frame, name)) + toNumber(v(1)));
            case 'list.add': return void list(frame, name).push(v(1));
            case 'list.del': {
                const l = list(frame, name);
                const i = listIndex(l, v(1));
                if (i >= 0 && i < l.length) l.splice(i, 1);
                return;
            }
            case 'list.ins': {
                const l = list(frame, name);
                const i = listIndex(l, v(1));
                if (i >= 0 && i <= l.length) l.splice(i, 0, v(2));
                return;
            }
            case 'list.set': {
                const l = list(frame, name);
                const i = listIndex(l, v(1));
                if (i >= 0 && i < l.length) l[i] = v(2);
                return;
            }
            case 'list.clear': return void list(frame, name).splice(0);
            case 'sb': return void trace.push({ op: op.opcode, args: Object.fromEntries(op.keys.map((k, i) => [k, v(i)])) });
            case 'broadcast':
            case 'broadcast.wait': return void trace.push({ op: op.op, args: { message: toString(v(0)) } });
            case 'wait': return;
            case 'stop':
                if (v(0) === 'other scripts in sprite') return;
                throw new StopSignal(v(0));
            case 'ret': throw new ReturnSignal(op.args.length ? v(0) : '');
            case 'break': throw new BreakSignal();
            case 'continue': throw new ContinueSignal();
            case 'call': return void call(op, frame);
            case 'if':
                if (toBoolean(v(0))) execRegion(op.regions[0], frame);
                else if (op.regions[1]) execRegion(op.regions[1], frame);
                return;
            case 'repeat': {
                const n = Math.round(toNumber(v(0)));
                for (let i = 0; i < n; i++) if (!loopBody(op.regions[0], frame)) break;
                return;
            }
            case 'forever':
                while (loopBody(op.regions[0], frame)) if (++steps > maxSteps) throw new StepLimitExceeded(`more than ${maxSteps} steps`);
                return;
            case 'until':
                while (!condition(op.regions[0], frame)) if (!loopBody(op.regions[1], frame)) break;
                return;
            case 'wait.until':
                while (!condition(op.regions[0], frame)) if (++steps > maxSteps) throw new StepLimitExceeded('wait.until never became true');
                return;
        }
        throw new Error(`cannot execute \`${op.op}\``);
    }

    function execRegion(region, frame) {
        for (const op of region) exec(op, frame);
    }

    for (const target of mod.targets) {
        for (const d of target.vars) store.set(d, d.kind === 'list' ? [] : 0);
    }

    outer: for (const target of mod.targets) {
        for (const script of target.scripts) {
            if (script.hat.event !== event) continue;
            try {
                execRegion(script.body, { target, args: new Map(), values: new Map(), defs: new Map() });
            } catch (e) {
                if (!(e instanceof StopSignal)) throw e;
                if (e.kind === 'all') break outer;
            }
        }
    }

    const vars = {};
    const lists = {};
    for (const [d, val] of store) (d.kind === 'list' ? lists : vars)[d.name] = val;
    return { vars, lists, trace };
}
