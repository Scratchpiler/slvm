#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parse, verify, runPipeline } from '../src/index.js';
import { slc } from '../src/slc/index.js';

const USAGE = `usage: slc [-p pass,pass,...] <file.sl | ->

Lowers legal SLVM IR to Scratch blocks and prints them as JSON, one entry per target
with its variables and a block map in scratch-vm's in-memory format (what Scratchpiler's
injector consumes). Use -p legalize to legalize first.`;

const argv = process.argv.slice(2);
let passes = [];
let file = null;
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p') passes = argv[++i].split(',').filter(Boolean);
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else file = a;
}
if (!file) { console.error(USAGE); process.exit(2); }

try {
    const mod = parse(readFileSync(file === '-' ? 0 : file, 'utf8'));
    const errors = verify(mod);
    if (errors.length) throw new Error(`input IR invalid:\n  ${errors.join('\n  ')}`);
    runPipeline(mod, passes);
    process.stdout.write(JSON.stringify(slc(mod), null, 2) + '\n');
} catch (e) {
    console.error(`slc: ${e.message}`);
    process.exit(1);
}
