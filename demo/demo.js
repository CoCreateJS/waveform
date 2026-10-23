const control = document.querySelector("#control");
const label = document.querySelector("#control-label");
const sampleButton = document.querySelector("#sample");
const status = document.querySelector("#status");
const statusText = document.querySelector("#status-text");
const visualization = document.querySelector("#visualization");
const title = document.querySelector("#bars-title");
const canvas = document.querySelector("#bars");
const caption = document.querySelector("#bars-caption");
let sampleAudio;

const views = {
    line: ["Live waveform line", "The current audio signal, redrawn each frame."],
    bars: ["Centered mirrored bars", "The current audio signal mirrored around the center."],
    history: ["Recording history", "New sound appears at the right while earlier sound moves left. The history stays visible after recording stops."]
};

visualization.addEventListener("change", () => {
    const [heading, description] = views[visualization.value];
    control.setAttribute("waveform-visualization", visualization.value);
    title.textContent = heading;
    caption.textContent = description;
    canvas.setAttribute("aria-label", description);
});

control.addEventListener("waveform-start", event => {
    const isSample = sampleAudio?.stream === event.detail.stream;
    label.textContent = isSample ? "Stop sample audio" : "Stop microphone";
    control.setAttribute("aria-label", label.textContent);
    statusText.textContent = isSample ? "Sample audio playing" : "Listening to your microphone";
    status.dataset.active = "true";
    delete status.dataset.error;
});

control.addEventListener("waveform-end", () => {
    if (sampleAudio) {
        const { context, carrier, modulator, stream } = sampleAudio;
        sampleAudio = undefined;
        carrier.stop();
        modulator.stop();
        stream.getTracks().forEach(track => track.stop());
        void context.close();
    }
    label.textContent = "Start microphone";
    control.setAttribute("aria-label", label.textContent);
    status.dataset.active = "false";
    if (!status.dataset.error) statusText.textContent = "Stopped";
});

control.addEventListener("waveform-error", event => {
    statusText.textContent = event.detail.error.message;
    status.dataset.error = "true";
    status.dataset.active = "false";
});

sampleButton.addEventListener("click", async () => {
    sampleButton.disabled = control.disabled = true;
    try {
        await CoCreate.waveform.stop(control);
        const context = new AudioContext();
        const destination = context.createMediaStreamDestination();
        const carrier = context.createOscillator();
        const gain = context.createGain();
        const modulator = context.createOscillator();
        const modulationGain = context.createGain();
        carrier.frequency.value = 180;
        gain.gain.value = 0.15;
        modulator.frequency.value = 1.2;
        modulationGain.gain.value = 0.13;
        carrier.connect(gain).connect(destination);
        modulator.connect(modulationGain).connect(gain.gain);
        carrier.start();
        modulator.start();
        sampleAudio = { context, carrier, modulator, stream: destination.stream };
        await CoCreate.waveform.start({ element: control, stream: destination.stream, context });
    } catch (error) {
        statusText.textContent = error.message;
        status.dataset.error = "true";
    } finally {
        sampleButton.disabled = control.disabled = false;
    }
});
