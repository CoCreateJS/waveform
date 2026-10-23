/*!
 * CoCreate-waveform — Web Audio waveform analysis and visualization.
 * https://cocreate.app
 * Released under the MIT license
 */
import observer from "@cocreate/observer";
import actions from "@cocreate/actions";
import { queryElements } from "@cocreate/utils";

const selector = "[waveform-query], [waveform]";
const initialized = new WeakSet();
const sessions = new WeakMap();

function dispatch(element, name, detail) {
    element.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
    const alias = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
    element.dispatchEvent(new CustomEvent(alias, { bubbles: true, detail }));
}

function setActive(element, active) {
    if (active) element.setAttribute("waveform-active", "true");
    else element.removeAttribute("waveform-active");
}

function setStatus(element, status) {
    if (element.matches(selector) && element.getAttribute("waveform") !== status)
        element.setAttribute("waveform", status);
}

function draw(current) {
    const { canvas, drawing, samples } = current;
    if (!drawing) return;
    const { width, height } = canvas;
    drawing.clearRect(0, 0, width, height);
    drawing.beginPath();
    drawing.strokeStyle = getComputedStyle(canvas).color;
    drawing.lineWidth = 2;
    for (let index = 0; index < samples.length; index++) {
        const x = index * width / (samples.length - 1);
        const y = (1 - samples[index]) * height / 2;
        if (index === 0) drawing.moveTo(x, y);
        else drawing.lineTo(x, y);
    }
    drawing.stroke();
}

function update(current) {
    if (current.cancelled) return;
    try {
        current.analyser.getFloatTimeDomainData(current.samples);
        draw(current);
        dispatch(current.element, "waveformData", {
            samples: current.samples, analyser: current.analyser,
            context: current.context, stream: current.stream
        });
        if (!current.cancelled) current.frame = requestAnimationFrame(() => update(current));
    } catch (error) {
        dispatch(current.element, "waveformError", { error });
        void release(current);
    }
}

function release(current) {
    if (!current) return Promise.resolve();
    if (current.cleanup) return current.cleanup;
    current.cancelled = true;
    setStatus(current.element, "stop");
    setActive(current.element, false);
    cancelAnimationFrame(current.frame);
    current.source?.disconnect();
    current.analyser?.disconnect();
    for (const track of current.stream?.getAudioTracks() || []) {
        track.removeEventListener("ended", current.onEnded);
    }
    if (current.ownsStream) current.stream?.getTracks().forEach(track => track.stop());
    current.drawing?.clearRect(0, 0, current.canvas.width, current.canvas.height);
    current.cleanup = Promise.resolve().then(() => {
        if (current.ownsContext && current.context?.state !== "closed") return current.context?.close();
    }).catch(error => {
        dispatch(current.element, "waveformError", { error });
    }).then(() => {
        if (sessions.get(current.element) === current) {
            sessions.delete(current.element);
            setStatus(current.element, "end");
        }
        dispatch(current.element, "waveformEnd", {
            stream: current.stream, analyser: current.analyser, context: current.context
        });
    });
    return current.cleanup;
}

function start(options = {}, element) {
    if (options.nodeType) {
        element = options;
        options = {};
    } else element = element || options.element;
    if (!element) return Promise.reject(new TypeError("Waveform requires a host element."));
    const existing = sessions.get(element);
    if (existing) {
        if (existing.cancelled) return existing.cleanup.then(() => start(options, element));
        return existing.ready;
    }

    const current = {
        element, ownsStream: !options.stream, ownsContext: !options.context,
        cancelled: false, started: false
    };
    sessions.set(element, current);
    setStatus(element, "start");
    current.ready = (async () => {
        try {
            const Constructor = window.AudioContext || window.webkitAudioContext;
            if (!options.context && !Constructor) throw new Error("Web Audio API is not supported.");
            current.context = options.context || new Constructor();
            current.analyser = current.context.createAnalyser();
            current.analyser.fftSize = options.fftSize ?? Number(element.getAttribute("waveform-fft-size") || 2048);
            current.samples = new Float32Array(current.analyser.fftSize);
            current.canvas = options.target;
            if (!current.canvas && element.hasAttribute("waveform-query")) {
                [current.canvas] = queryElements({ element, prefix: "waveform" });
                if (!current.canvas) throw new Error("Waveform query did not match a canvas.");
            } else if (!current.canvas && element.matches("canvas")) current.canvas = element;
            if (current.canvas) {
                current.drawing = current.canvas.getContext("2d");
                if (!current.drawing) throw new Error("Waveform requires a 2D canvas context.");
            }

            // Resume within the initiating gesture, before waiting for microphone permission.
            const resumed = current.context.state === "suspended" ? current.context.resume() : Promise.resolve();
            const streamReady = Promise.resolve().then(() => {
                if (current.cancelled) return;
                return options.stream || navigator.mediaDevices.getUserMedia({ audio: options.audio ?? true });
            }).then(stream => {
                current.stream = stream;
                // Permission may resolve after stop() or removal of the host.
                if (current.cancelled && current.ownsStream) stream?.getTracks().forEach(track => track.stop());
                return stream;
            });
            await Promise.all([resumed, streamReady]);
            if (current.cancelled) return;
            const tracks = current.stream.getAudioTracks();
            if (!tracks.some(track => track.readyState === "live")) throw new Error("Waveform requires a live audio track.");
            current.source = current.context.createMediaStreamSource(current.stream);
            current.source.connect(current.analyser);
            // The analyser is intentionally not connected to the speakers.
            current.onEnded = () => {
                if (!tracks.some(track => track.readyState === "live")) void release(current);
            };
            tracks.forEach(track => track.addEventListener("ended", current.onEnded));
            current.started = true;
            setActive(element, true);
            dispatch(element, "waveformStart", {
                stream: current.stream, analyser: current.analyser, context: current.context
            });
            update(current);
            if (!current.cancelled) return current;
        } catch (error) {
            if (current.cancelled) return;
            dispatch(element, "waveformError", { error });
            await release(current);
            throw error;
        }
    })();
    return current.ready;
}

function stop(element) {
    const current = sessions.get(element);
    if (!current) setStatus(element, "end");
    return release(current);
}

function toggle(element) {
    return sessions.has(element) ? stop(element) : start(element);
}

function applyCommand(element) {
    const command = element.getAttribute("waveform");
    if (command === "start") void start(element).catch(() => { });
    else if (command === "stop") void stop(element);
}

function init(elements = document.querySelectorAll(selector)) {
    if (elements.nodeType) elements = [elements];
    for (const element of elements) {
        if (!element.matches(selector)) continue;
        if (!initialized.has(element)) {
            initialized.add(element);
            setActive(element, false);
            element.addEventListener("click", () => {
                if (element.matches(selector) && !element.hasAttribute("actions") &&
                    !element.disabled && element.getAttribute("aria-disabled") !== "true") {
                    void toggle(element).catch(() => { });
                }
            });
        }
        applyCommand(element);
    }
}

actions.init({
    name: ["waveform", "waveformStart", "waveformStop"],
    endEvent: "waveformActionEnd",
    callback: async action => {
        try {
            const method = action.method || ({ waveformStart: "start", waveformStop: "stop" })[action.name] || "toggle";
            if (!["start", "stop", "toggle"].includes(method)) throw new Error(`Unknown waveform method: ${method}`);
            const current = await ({ start, stop, toggle })[method](action.element);
            if (method === "start" && !current) throw new Error("Waveform start was cancelled.");
            action.end({ analyser: current?.analyser, context: current?.context, stream: current?.stream });
        } catch (error) {
            action.abort(error);
        }
    }
});

observer.init({
    name: "CoCreateWaveformAddedNodes",
    types: ["addedNodes"], selector,
    callback: mutation => init(mutation.target)
});
observer.init({
    name: "CoCreateWaveformAttributes",
    types: ["attributes"], attributeFilter: ["waveform", "waveform-query"],
    callback: mutation => {
        if (mutation.target.matches(selector)) init(mutation.target);
        else void stop(mutation.target);
    }
});
observer.init({
    name: "CoCreateWaveformRemovedNodes",
    types: ["removedNodes"], selector,
    callback: mutation => {
        if (!mutation.target.isConnected) void stop(mutation.target);
    }
});

init();

export default { init, start, stop, toggle };
