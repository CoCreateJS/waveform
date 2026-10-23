# CoCreate-waveform

Declarative audio waveform analysis and visualization using the Web Audio API.
The component entry point is `src/index.js`.

The core pipeline is **MediaStream → AudioContext source → AnalyserNode → waveform
samples / canvas**. It uses `getFloatTimeDomainData`, producing floating-point
time-domain samples centered on zero.
The analyser is not connected to the speakers.

## Try it

```sh
npm start
python3 -m http.server 8080
```

Open `http://localhost:8080/demo/index.html` and use the view selector to compare
the live line, mirrored bars, and recording history. Click Start microphone or
Try sample audio. A remote host needs
HTTPS for microphone access. The browser handles microphone permission and may
require a user gesture to resume audio processing.

The development build exports `CoCreate.waveform`. Use `npm run build` for the
production bundle.
There is no required component stylesheet: canvas stroke color follows its CSS
`color`, and canvas `width` / `height` attributes set drawing resolution.

## Declarative API

```html
<button
	type="button"
	waveform-query="$document #wave"
	waveform-fft-size="2048"
	aria-label="Toggle waveform">
	Start / stop
</button>
<canvas id="wave" width="960" height="240" aria-label="Live waveform"></canvas>
```

| Attribute           | Purpose                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `waveform`          | Lifecycle: `start` / `stop` commands, `end` completion; empty initializes an idle toggle. |
| `waveform-query`    | CoCreate query selecting the first target canvas.                                         |
| `waveform-fft-size` | Samples per frame; power of two from 32–32768, default 2048.                              |
| `waveform-visualization` | Canvas style: `line` (default), centered mirrored `bars`, or scrolling `history`. |
| `waveform-active`   | Output flag: `true` after analysis starts; removed on stop or failure.                    |

The built-in visualizations need only a target canvas and CSS `color`. `line`
draws the current sample frame, and `bars` mirrors that live signal around the
center. Both redraw as new audio arrives. `history` instead records recent audio
levels and scrolls them from right to left. History remains on the canvas after
stopping and resets when the next session starts. Without a canvas target, the
component emits data for a custom renderer.

`waveform-query` alone initializes a control and attaches its click listener. The
main `waveform` attribute is created on first start. Initialization attributes
are watched for existing elements, added nodes, and later attribute changes.
The visualization can also be changed while analysis is running.

A canvas can itself be the host with `<canvas waveform>` and no query. Capture
attributes are read when a session starts and can be assigned by separate
CoCreate Events controls. Clicks, API calls, Actions, and attribute commands
share the lifecycle:

- `start`: setup requested; analysis runs once audio is available.
- `stop`: animation stops and the audio graph/resources are being released.
- `end`: cleanup completed, including after track end or an initialization failure.

`waveform-active="true"` distinguishes running analysis from a pending start.
`end` remains until the next start. Clicks toggle start/stop; clicking while cleanup
is still running waits for completion. Repeated Observer notifications do not
repeat operations. Stopping releases the analysis resources; no separate abort
command is necessary.

Observer handles existing and added elements, command changes, removal of both
initialization attributes,
and disconnected hosts. A same-batch move within the document does not stop
analysis. Each host has its own session; repeated start commands are idempotent.
Direct clicks toggle unless the host has an `actions` attribute.

## Existing audio streams

```js
import waveform from "./src/index.js";

const host = document.querySelector("[waveform-query], [waveform]");
const session = await waveform.start({
	element: host,
	stream: existingMediaStream,
	// Optional: reuse an existing AudioContext too.
	context: existingAudioContext,
	fftSize: 2048
});

session.analyser.getFloatTimeDomainData(session.samples);
await waveform.stop(host);
```

`start(element)`, `start({ element, stream, context, target, fftSize, audio })`,
`stop(element)`, `toggle(element)`, and `init(elementOrCollection)` are available.
`init()` scans the document. `start` resolves with the session after setup, rejects
on failure, or resolves undefined if cancelled while starting.

If no stream is supplied, the component requests one with
`navigator.mediaDevices.getUserMedia({ audio: true })`. The JavaScript `audio`
option can provide capture constraints. Stop releases streams and contexts
created by the component, while caller-supplied streams and contexts remain owned
by the caller. Pending permission requests cannot be cancelled by this component;
if a stream arrives after stop, its tracks are released immediately.

## Events and optional Actions

Bubbling events have both forms:

- `waveformStart` / `waveform-start`: analysis started.
- `waveformData` / `waveform-data`: one frame of samples.
- `waveformEnd` / `waveform-end`: a requested session finished cleanup, including cancellation during setup.
- `waveformError` / `waveform-error`: capture, analysis, or rendering failed.

Start and end details include `stream`, `context`, and `analyser`. Data details
also include `samples`, a reused `Float32Array`; copy it with `samples.slice()` if
retaining a frame. Error details include `error`. Labels and application state
remain in the UI, using these events and CoCreate Events if desired.

```html
<button
	type="button"
	actions="waveformStart, nextAction"
	waveform-query="$document #wave">
	Start
</button>
```

Optional Actions are `waveformStart`, `waveformStop`, and `waveform` (toggle).
The Actions framework also supports `waveform.start`, `waveform.stop`, and
`waveform.toggle`. Start advances after setup; stop advances after
cleanup; errors abort the chain. Actions are scoped to their host element. To
stop that host from a separate control, set its `waveform` attribute to `stop`
through CoCreate Events. `nextAction` represents your application's next action.
