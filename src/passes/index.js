import { constfold } from './constfold.js';
import { dce } from './dce.js';
import { lowerRet } from './lower-ret.js';
import { lowerBreak } from './lower-break.js';
import { rotateCond } from './rotate-cond.js';
import { materializeBool } from './materialize-bool.js';
import { spill } from './spill.js';
import { verify } from '../verify.js';
import { print } from '../text.js';

export class VerificationError extends Error {}

export const PASSES = {
    constfold,
    dce,
    'lower-ret': lowerRet,
    'lower-break': lowerBreak,
    'rotate-cond': rotateCond,
    'materialize-bool': materializeBool,
    spill,
};

export const ALIASES = {
    legalize: ['lower-ret', 'lower-break', 'rotate-cond', 'materialize-bool', 'spill'],
};

export const expandPipeline = (names) => names.flatMap((n) => ALIASES[n] ?? [n]);

export function runPipeline(mod, names, { verifyEach = true, printAfterAll = null } = {}) {
    for (const name of expandPipeline(names)) {
        const pass = PASSES[name];
        if (!pass) throw new Error(`unknown pass \`${name}\` (known: ${[...Object.keys(PASSES), ...Object.keys(ALIASES)].join(', ')})`);
        pass(mod);
        if (printAfterAll) printAfterAll(`; *** IR after ${name} ***\n${print(mod)}`);
        if (verifyEach) {
            const errors = verify(mod);
            if (errors.length) throw new VerificationError(`IR invalid after ${name}:\n  ${errors.join('\n  ')}`);
        }
    }
    return mod;
}
