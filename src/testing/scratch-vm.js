import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';

const require = createRequire(import.meta.url);

let VirtualMachine = null;
let Sprite = null;
try {
    const entry = require.resolve('scratch-vm');
    VirtualMachine = require(entry);
    Sprite = require(join(dirname(entry), '..', '..', 'src', 'sprites', 'sprite.js'));
} catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    VirtualMachine = null;
}

export const hasScratchVM = VirtualMachine !== null;

const SPEECH_OPCODES = new Set(['looks_say', 'looks_sayforsecs', 'looks_think', 'looks_thinkforsecs']);

export const speechOf = (trace) =>
    trace.filter((e) => SPEECH_OPCODES.has(e.op)).map((e) => String(e.args.MESSAGE)).filter((m) => m !== '');

export async function runInScratchVM(compiled, { maxFrames = 3000, frameMs = 1000 / 30, runFor = null, seed = 1 } = {}) {
    const vm = new VirtualMachine();
    const said = [];
    vm.runtime.on('SAY', (target, type, text) => { if (text !== '') said.push(String(text)); });

    const targets = compiled.targets.map((t) => {
        const sprite = new Sprite(null, vm.runtime);
        sprite.name = t.name;
        const target = sprite.createClone();
        target.isStage = t.kind === 'stage';
        vm.runtime.addTarget(target);
        for (const v of t.variables) {
            target.createVariable(v.id, v.name, v.type);
            if (v.value !== undefined) target.variables[v.id].value = structuredClone(v.value);
        }
        for (const b of Object.values(t.blocks)) target.blocks.createBlock(structuredClone(b));
        return target;
    });

    const realRandom = Math.random;
    let rng = seed >>> 0;
    Math.random = () => {
        rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
        return rng / 2 ** 32;
    };
    const realNow = Date.now;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let now = realNow();
    const timers = new Map();
    let nextTimer = 1;
    Date.now = () => (now += 0.001);
    globalThis.setTimeout = (fn, ms = 0, ...args) => {
        timers.set(nextTimer, { due: now + ms, fn: () => fn(...args) });
        return nextTimer++;
    };
    globalThis.clearTimeout = (id) => timers.delete(id);
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    let frames = 0;
    try {
        vm.runtime.currentStepTime = frameMs;
        vm.greenFlag();
        do {
            vm.runtime._step();
            now += frameMs;
            for (const [id, t] of [...timers]) {
                if (t.due > now) continue;
                timers.delete(id);
                t.fn();
            }
            await settle();
        } while ((runFor !== null ? ++frames < runFor : vm.runtime.threads.length && ++frames < maxFrames));
    } finally {
        Math.random = realRandom;
        Date.now = realNow;
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
    }
    if (runFor === null && vm.runtime.threads.length) throw new Error(`scripts still running after ${maxFrames} frames`);

    const vars = {};
    const lists = {};
    const sprites = {};
    for (const target of targets) {
        if (!target.isStage) {
            sprites[target.sprite.name] = {
                x: target.x, y: target.y, direction: target.direction, size: target.size, visible: target.visible,
            };
        }
        for (const v of Object.values(target.variables)) {
            if (v.type === '') vars[v.name] = v.value;
            else if (v.type === 'list') lists[v.name] = [...v.value];
        }
    }
    return { vars, lists, said, sprites, frames };
}
