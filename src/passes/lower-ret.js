import { declareVar, mkOp, lit, sym } from '../ir.js';

export const retVarName = (proc) => `__ret_${proc}`;

const stopThisScript = () => mkOp('stop', [lit('this script')]);
const isStopThisScript = (op) => op?.op === 'stop' && op.args[0].lit === 'this script';

function lowerRegion(region, target, proc) {
    const out = [];
    for (const op of region) {
        op.regions = op.regions.map((r) => lowerRegion(r, target, proc));
        if (op.op === 'ret') {
            if (op.args.length) out.push(mkOp('var.set', [sym(declareVar(target, 'var', retVarName(proc.name))), op.args[0]]));
            out.push(stopThisScript());
        } else if (op.op === 'call' && op.result !== null) {
            const retVar = declareVar(target, 'var', retVarName(op.callee));
            out.push({ ...op, result: null });
            out.push(mkOp('var.get', [sym(retVar)], { result: op.result }));
        } else {
            out.push(op);
        }
    }
    return out;
}

export function lowerRet(mod) {
    for (const target of mod.targets) {
        for (const proc of target.procs) {
            proc.body = lowerRegion(proc.body, target, proc);
            if (isStopThisScript(proc.body.at(-1))) proc.body.pop();
        }
        for (const script of target.scripts) script.body = lowerRegion(script.body, target, null);
    }
    return mod;
}
