const control = document.querySelector("#control");
const controlLabel = document.querySelector("#control-label");
const sampleButton = document.querySelector("#sample");
const status = document.querySelector("#status");
const statusText = document.querySelector("#status-text");
const bars = document.querySelector("#bars");
const meter = document.querySelector("#meter");
const levelValue = document.querySelector("#level-value");
const barView = document.querySelector("#bar-view");
const barsTitle = document.querySelector("#bars-title");
const barsCaption = document.querySelector("#bars-caption");
const history = [];
const barCount = 49;
let lastFrame = -Infinity;
let sampleAudio;

function drawBars() {
    const ctx = bars.getContext("2d");
    const { width, height } = bars;
    const count = barCount;
    const mirrored = barView.value === "mirror";
    const step = width / count;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = getComputedStyle(bars).color;
    for (let index = 0; index < count; index++) {
        const distance = Math.abs(index - Math.floor(count / 2));
        const sampleIndex = mirrored ? history.length - 1 - distance : index - (count - history.length);
        const amplitude = (history[sampleIndex] || 0) * (mirrored ? 1 - distance / 25 * 0.35 : 1);
        const barHeight = Math.max(5, amplitude * height * 0.86);
        const barWidth = step * 0.42;
        ctx.globalAlpha = sampleIndex < 0 ? 0.2 : mirrored ? 1 - distance / 25 * 0.55 : 0.9;
        ctx.beginPath();
        ctx.roundRect(index * step + (step - barWidth) / 2, (height - barHeight) / 2, barWidth, barHeight, barWidth / 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

function drawMeter(level) {
    const ctx = meter.getContext("2d");
    const { width, height } = meter;
    const count = 40;
    const step = width / count;
    ctx.clearRect(0, 0, width, height);
    for (let index = 0; index < count; index++) {
        ctx.fillStyle = index / count < level ? getComputedStyle(meter).color : "#243c30";
        ctx.beginPath();
        ctx.roundRect(index * step, height * 0.35, step * 0.55, height * 0.3, 4);
        ctx.fill();
    }
    levelValue.textContent = `${Math.round(level * 100)}%`;
}

function resetViews() {
    history.length = 0;
    lastFrame = -Infinity;
    drawBars();
    drawMeter(0);
}

function disposeSample() {
    if (!sampleAudio) return;
    const { context, carrier, modulator, stream } = sampleAudio;
    sampleAudio = undefined;
    carrier.stop();
    modulator.stop();
    stream.getTracks().forEach(track => track.stop());
    void context.close();
}

control.addEventListener("waveform-data", event => {
    const now = performance.now();
    if (now - lastFrame < 80) return;
    lastFrame = now;
    const { samples } = event.detail;
    let squares = 0;
    for (const value of samples) squares += value * value;
    const level = Math.min(1, Math.sqrt(squares / samples.length) * 3.5);
    history.push(level);
    if (history.length > barCount) history.shift();
    drawBars();
    drawMeter(level);
});

control.addEventListener("waveform-start", event => {
    resetViews();
    const isSample = sampleAudio?.stream === event.detail.stream;
    const label = isSample ? "Stop sample audio" : "Stop microphone";
    controlLabel.textContent = label;
    control.setAttribute("aria-label", label);
    statusText.textContent = isSample ? "Sample audio playing" : "Listening to your microphone";
    status.dataset.active = "true";
    delete status.dataset.error;
});
control.addEventListener("waveform-end", () => {
    disposeSample();
    drawMeter(0);
    controlLabel.textContent = "Start microphone";
    control.setAttribute("aria-label", "Start microphone");
    status.dataset.active = "false";
    if (!status.dataset.error) statusText.textContent = "Stopped";
});
control.addEventListener("waveform-error", event => {
    statusText.textContent = event.detail.error.message;
    status.dataset.error = "true";
    status.dataset.active = "false";
});

barView.addEventListener("change", () => {
    const mirrored = barView.value === "mirror";
    barsTitle.textContent = mirrored ? "Centered mirrored bars" : "Recording history";
    barsCaption.textContent = mirrored
        ? "New audio appears at the center and moves outward, mirrored on both sides."
        : "New sound enters at the right. Earlier sound moves left, preserving its shape.";
    bars.setAttribute("aria-label", mirrored
        ? "Audio amplitude bars mirrored around the horizontal and vertical center"
        : "Audio amplitude history scrolling from right to left");
    drawBars();
});

sampleButton.addEventListener("click", async () => {
    sampleButton.disabled = true;
    control.disabled = true;
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
        disposeSample();
        statusText.textContent = error.message;
        status.dataset.error = "true";
    } finally {
        sampleButton.disabled = false;
        control.disabled = false;
    }
});

resetViews();
