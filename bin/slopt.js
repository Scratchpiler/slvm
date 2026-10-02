#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parse, print, verify, runPipeline, PASSES, ALIASES } from '../src/index.js';

const USAGE = `usage: slopt [-p pass,pass,...] [--print-after-all] [--legal] <file.sl | ->

Parses SLVM IR, verifies it, runs the passes and prints the result.
passes: ${Object.keys(PASSES).join(', ')}
aliases: ${Object.entries(ALIASES).map(([k, v]) => `${k} = ${v.join(',')}`).join('; ')}`;

const argv = process.argv.slice(2);
let passes = [];
let printAfterAll = false;
let legal = false;
let file = null;
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p') passes = argv[++i].split(',').filter(Boolean);
    else if (a === '--print-after-all') printAfterAll = true;
    else if (a === '--legal') legal = true;
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else file = a;
}
if (!file) { console.error(USAGE); process.exit(2); }

try {
    const mod = parse(readFileSync(file === '-' ? 0 : file, 'utf8'));
    const errors = verify(mod);
    if (errors.length) throw new Error(`input IR invalid:\n  ${errors.join('\n  ')}`);
    runPipeline(mod, passes, { printAfterAll: printAfterAll ? (s) => process.stderr.write(s + '\n') : null });
    if (legal) {
        const legalErrors = verify(mod, { legal: true });
        if (legalErrors.length) throw new Error(`IR is not legal for the Scratch backend:\n  ${legalErrors.join('\n  ')}`);
    }
    process.stdout.write(print(mod));
} catch (e) {
    console.error(`slopt: ${e.message}`);
    process.exit(1);
}
