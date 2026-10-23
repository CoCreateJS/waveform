const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export default { init, start, stop, toggle };', 'this.api = { init, start, stop, toggle };');

class Element extends EventTarget {
    nodeType = 1;
    isConnected = true;
    attributes = new Map([['waveform', '']]);
    hasAttribute(name) { return this.attributes.has(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    matches(selector) {
        if (selector === 'canvas') return this.canvas;
        return selector.split(',').some(part => {
            const match = /^\[([\w-]+)\]$/.exec(part.trim());
            return match && this.hasAttribute(match[1]);
        });
    }
}
function stream() {
    const track = Object.assign(new EventTarget(), {
        readyState: 'live', stops: 0,
        stop() { this.stops++; this.readyState = 'ended'; }
    });
    return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}
function runtime(options = {}) {
    const element = new Element(), canvas = new Element(), observers = [], definitions = [], contexts = [], frames = new Map();
    const input = stream(), requests = [], points = [];
    let nextFrame = 0;
    canvas.canvas = true; canvas.width = 300; canvas.height = 150;
    const drawing = { clears: 0, strokes: 0, fills: 0,
        clearRect() { this.clears++; }, fillRect() { this.fills++; }, beginPath() { points.length = 0; },
        moveTo(x, y) { points.push([x, y]); }, lineTo(x, y) { points.push([x, y]); },
        stroke() { this.strokes++; }
    };
    canvas.getContext = () => drawing;
    class Context {
        state = 'suspended'; closes = 0; resumes = 0;
        constructor() { contexts.push(this); }
        resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
        close() { this.closes++; this.state = 'closed'; return Promise.resolve(); }
        createAnalyser() {
            return this.analyser = {
                size: 2048,
                set fftSize(value) {
                    if (value < 32 || value > 32768 || (value & (value - 1)) || !Number.isInteger(value)) throw new Error('Invalid FFT size');
                    this.size = value;
                },
                get fftSize() { return this.size; },
                getFloatTimeDomainData(data) { data.fill(0.5); },
                disconnect() { this.disconnected = true; }
            };
        }
        createMediaStreamSource(value) {
            return this.source = { stream: value,
                connect(target) { this.target = target; }, disconnect() { this.disconnected = true; }
            };
        }
    }
    if (options.queryOnly) {
        element.removeAttribute('waveform');
        element.setAttribute('waveform-query', '#wave');
    }
    if (options.command) element.setAttribute('waveform', options.command);
    const context = {
        window: options.supported === false ? {} : { AudioContext: Context },
        navigator: { mediaDevices: { getUserMedia(constraints) {
            requests.push(constraints);
            return options.request ? options.request() : Promise.resolve(input);
        } } },
        document: { querySelectorAll: () => [element] },
        observer: { init: value => observers.push(value) },
        actions: { init: value => definitions.push(value) },
        queryElements: () => options.missingTarget ? [] : [canvas],
        getComputedStyle: () => ({ color: 'rgb(0, 128, 0)' }),
        performance: { now: () => Date.now() },
        requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
        cancelAnimationFrame(id) { frames.delete(id); },
        CustomEvent, Float32Array
    };
    vm.runInNewContext(source, context);
    return { api: context.api, element, canvas, drawing, points, input, contexts, Context,
        observers, definitions, requests, frames,
        tick() { const [id, callback] = frames.entries().next().value; frames.delete(id); callback(); }
    };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const active = element => element.getAttribute('waveform-active') === 'true';

function command(app, value) {
    const oldValue = app.element.getAttribute('waveform');
    app.element.setAttribute('waveform', value);
    app.observers.find(item => item.types.includes('attributes')).callback({ target: app.element, oldValue });
}

test('analysis exposes floating-point waveform samples and draws them on the query canvas', async () => {
    const app = runtime();
    app.element.setAttribute('waveform-query', '#wave');
    app.element.setAttribute('waveform-fft-size', '32');
    let started, data, aliases = 0;
    app.element.addEventListener('waveformStart', event => { started = event.detail; });
    app.element.addEventListener('waveformData', event => { data = event.detail; });
    app.element.addEventListener('waveform-data', () => aliases++);
    const current = await app.api.start(app.element);
    assert.equal(started.analyser, current.analyser);
    assert.equal(started.context, current.context);
    assert.equal(data.samples.length, 32);
    assert.equal(data.samples[0], 0.5);
    assert.equal(app.contexts[0].source.target, current.analyser);
    assert.equal(app.drawing.strokeStyle, 'rgb(0, 128, 0)');
    assert.deepEqual(app.points[0], [0, 37.5]);
    assert.deepEqual(app.points.at(-1), [300, 37.5]);
    assert.equal(active(app.element), true);
    app.tick();
    assert.equal(aliases, 2);
    assert.equal(app.frames.size, 1);
    await app.api.stop(app.element);
});

test('built-in mirrored bars draw from the live signal samples', async () => {
    const app = runtime();
    app.element.setAttribute('waveform-query', '#wave');
    app.element.setAttribute('waveform-visualization', 'bars');
    app.element.setAttribute('waveform-fft-size', '32');
    await app.api.start({ element: app.element, stream: app.input });
    assert.equal(app.drawing.fills, 48);
    assert.equal(app.drawing.strokes, 0);
    await app.api.stop(app.element);
});

test('built-in history keeps its final drawing after stop and clears on the next start', async () => {
    const app = runtime();
    app.element.setAttribute('waveform-query', '#wave');
    app.element.setAttribute('waveform-visualization', 'history');
    app.element.setAttribute('waveform-fft-size', '32');
    await app.api.start({ element: app.element, stream: app.input });
    assert.ok(app.drawing.fills > 0);
    const clears = app.drawing.clears;
    await app.api.stop(app.element);
    assert.equal(app.drawing.clears, clears);
    await app.api.start({ element: app.element, stream: app.input });
    assert.ok(app.drawing.clears > clears);
    await app.api.stop(app.element);
});

test('a supplied stream avoids microphone access and remains owned by its caller', async () => {
    const app = runtime(), supplied = stream();
    const current = await app.api.start({ element: app.element, stream: supplied });
    assert.equal(app.requests.length, 0);
    assert.equal(current.stream, supplied);
    await app.api.stop(app.element);
    assert.equal(supplied.track.stops, 0);
    assert.equal(current.context.closes, 1);
});

test('a supplied AudioContext remains open when analysis stops', async () => {
    const app = runtime(), context = new app.Context();
    const current = await app.api.start({ element: app.element, stream: stream(), context });
    await app.api.stop(app.element);
    assert.equal(context.closes, 0);
    assert.equal(current.source.disconnected, true);
    assert.equal(current.analyser.disconnected, true);
});

test('stop cancels animation, releases owned resources and emits end once', async () => {
    const app = runtime();
    let ends = 0;
    app.element.addEventListener('waveform-end', () => ends++);
    const current = await app.api.start(app.element);
    await app.api.stop(app.element);
    await app.api.stop(app.element);
    assert.equal(active(app.element), false);
    assert.equal(app.frames.size, 0);
    assert.equal(app.input.track.stops, 1);
    assert.equal(current.context.closes, 1);
    assert.equal(ends, 1);
});

test('cancelling a pending permission request stops a stream that arrives later', async () => {
    let allow;
    const app = runtime({ request: () => new Promise(resolve => { allow = resolve; }) });
    let starts = 0;
    app.element.addEventListener('waveformStart', () => starts++);
    const pending = app.api.start(app.element);
    await flush();
    await app.api.stop(app.element);
    const late = stream();
    allow(late);
    assert.equal(await pending, undefined);
    assert.equal(late.track.stops, 1);
    assert.equal(starts, 0);
    assert.equal(app.frames.size, 0);
});

test('permission denial reports the error and closes the analysis context', async () => {
    const app = runtime({ request: () => Promise.reject(new Error('Permission denied')) });
    let errors = 0;
    app.element.addEventListener('waveform-error', () => errors++);
    await assert.rejects(app.api.start(app.element), /Permission denied/);
    assert.equal(errors, 1);
    assert.equal(app.contexts[0].closes, 1);
    assert.equal(active(app.element), false);
});

test('invalid FFT sizes and unmatched targets fail before requesting a microphone', async () => {
    const app = runtime();
    app.element.setAttribute('waveform-fft-size', '33');
    await assert.rejects(app.api.start(app.element), /FFT size/);
    assert.equal(app.requests.length, 0);
    const missing = runtime({ missingTarget: true });
    missing.element.setAttribute('waveform-query', '#missing');
    await assert.rejects(missing.api.start(missing.element), /did not match/);
    assert.equal(missing.requests.length, 0);
});

test('unsupported Web Audio reports a failure without opening the microphone', async () => {
    const app = runtime({ supported: false });
    await assert.rejects(app.api.start(app.element), /not supported/);
    assert.equal(app.requests.length, 0);
});

test('track end stops analysis and removes the active flag', async () => {
    const app = runtime();
    await app.api.start(app.element);
    app.input.track.readyState = 'ended';
    app.input.track.dispatchEvent(new Event('ended'));
    await flush();
    assert.equal(active(app.element), false);
    assert.equal(app.frames.size, 0);
    assert.equal(app.contexts[0].closes, 1);
});

test('attribute commands and repeated initialization do not duplicate sessions', async () => {
    const app = runtime();
    command(app, 'start');
    app.api.init(app.element);
    command(app, 'start');
    await flush();
    assert.equal(app.contexts.length, 1);
    assert.equal(app.requests.length, 1);
    assert.equal(active(app.element), true);
    command(app, 'stop');
    await flush();
    assert.equal(active(app.element), false);
});

test('removal releases resources while a same-batch DOM move preserves them', async () => {
    const app = runtime();
    await app.api.start(app.element);
    const removed = app.observers.find(item => item.types.includes('removedNodes'));
    removed.callback({ target: app.element });
    assert.equal(active(app.element), true);
    app.element.isConnected = false;
    removed.callback({ target: app.element });
    await flush();
    assert.equal(active(app.element), false);
    assert.equal(app.input.track.stops, 1);
});

test('click toggles work without Actions and defer to Actions when configured', async () => {
    const app = runtime();
    app.api.init(app.element);
    app.element.dispatchEvent(new Event('click'));
    await flush();
    assert.equal(app.requests.length, 1);
    app.element.dispatchEvent(new Event('click'));
    await flush();
    assert.equal(active(app.element), false);
    app.element.setAttribute('actions', 'waveform.start');
    app.element.dispatchEvent(new Event('click'));
    await flush();
    assert.equal(app.requests.length, 1);
});

test('optional Actions complete after analysis starts and after cleanup stops it', async () => {
    const app = runtime(), calls = [];
    const run = method => app.definitions[0].callback({ element: app.element, method,
        end: () => calls.push('end'), abort: () => calls.push('abort') });
    const pending = run('start');
    assert.deepEqual(calls, []);
    await pending;
    assert.equal(active(app.element), true);
    await run('stop');
    assert.equal(app.contexts[0].state, 'closed');
    await run('invalid');
    assert.deepEqual(calls, ['end', 'end', 'abort']);
});


test('query-only hosts initialize clicks and synchronize start, stop and end', async () => {
    const app = runtime({ queryOnly: true });
    assert.equal(app.element.hasAttribute('waveform'), false);
    app.element.dispatchEvent(new Event('click'));
    assert.equal(app.element.getAttribute('waveform'), 'start');
    await flush();
    assert.equal(active(app.element), true);
    app.element.dispatchEvent(new Event('click'));
    assert.equal(app.element.getAttribute('waveform'), 'stop');
    await flush();
    assert.equal(app.element.getAttribute('waveform'), 'end');
    assert.equal(active(app.element), false);
});

test('Observer initializes added query controls and later query attributes once', async () => {
    for (const type of ['addedNodes', 'attributes']) {
        const app = runtime();
        const added = new Element();
        added.removeAttribute('waveform');
        added.setAttribute('waveform-query', '#wave');
        const config = app.observers.find(item => item.types.includes(type));
        config.callback({ target: added });
        app.api.init(added);
        added.dispatchEvent(new Event('click'));
        await flush();
        assert.equal(app.requests.length, 1);
        assert.equal(added.getAttribute('waveform'), 'start');
        await app.api.stop(added);
        assert.equal(added.getAttribute('waveform'), 'end');
    }
});

test('status remains stop until cleanup finishes and Observer feedback does not restart', async () => {
    const app = runtime();
    const current = await app.api.start(app.element);
    let finish;
    current.context.close = () => new Promise(resolve => { finish = resolve; });
    const stopped = app.api.stop(app.element);
    command(app, 'stop');
    await flush();
    assert.equal(app.element.getAttribute('waveform'), 'stop');
    finish(); await stopped;
    assert.equal(app.element.getAttribute('waveform'), 'end');
    command(app, 'end');
    assert.equal(app.requests.length, 1);
});

test('component-first actions start and stop, and cancellation finishes at end', async () => {
    const app = runtime(), calls = [];
    const run = name => app.definitions[0].callback({ name, element: app.element,
        end: () => calls.push('end'), abort: () => calls.push('abort') });
    await run('waveformStart');
    assert.equal(app.element.getAttribute('waveform'), 'start');
    await run('waveformStop');
    assert.equal(app.element.getAttribute('waveform'), 'end');
    assert.deepEqual(calls, ['end', 'end']);
});

test('removing both attributes does not restore them during cleanup', async () => {
    const app = runtime({ queryOnly: true });
    await app.api.start(app.element);
    app.element.removeAttribute('waveform');
    app.element.removeAttribute('waveform-query');
    app.observers.find(item => item.types.includes('attributes')).callback({ target: app.element });
    await flush();
    assert.equal(app.element.hasAttribute('waveform'), false);
    assert.equal(app.input.track.stops, 1);
});
