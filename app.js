const canvas = document.getElementById("spectrogram");
const ctx = canvas.getContext("2d", { alpha: false });

const statusEl = document.getElementById("status");
const startButtonEl = document.getElementById("startButton");
const pauseButtonEl = document.getElementById("pauseButton");
const calibrateButtonEl = document.getElementById("calibrateButton");
const recordToggleButtonEl = document.getElementById("recordToggleButton");
const recordStatusEl = document.getElementById("recordStatus");
const recordPanelEl = document.querySelector(".recordPanel");
const recordStartIcon = `<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" /></svg>`;
const recordStopIcon = `<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1" /></svg>`;
const deviceSelectEl = document.getElementById("deviceSelect");
const sampleRateInputEl = document.getElementById("sampleRateInput");
const windowSizeInputEl = document.getElementById("windowSizeInput");
const channelsInputEl = document.getElementById("channelsInput");
const historyInputEl = document.getElementById("historyInput");
const maxFrequencyInputEl = document.getElementById("maxFrequencyInput");
const calibrationInputEl = document.getElementById("calibrationInput");
const freqHighEl = document.getElementById("freqHigh");
const freqMidEl = document.getElementById("freqMid");
const freqLowEl = document.getElementById("freqLow");

const minDb = -95;
const maxDb = -15;

let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let splitterNode = null;
let recorderNode = null;
let columns = [];
let frequencies = [];
let frequencyBins = [];
let spectrumBuffers = [];
let analysisWindow = new Float32Array(0);
let noiseSums = [];
let noiseFloor = null;
let calibrationFramesSeen = 0;
let isPaused = false;
let lastLiveStatus = "開始を押してください";
let isRecording = false;
let recordingRequestPending = false;
let startStreamPromise = null;
let recordingStartedAt = 0;
let recordingFrameCount = 0;
let recordingChunks = [];
let recordingStatusTimer = null;

const DB_NAME = "piezoVisualizerRecordings";
const DB_VERSION = 1;
const RECORDING_STORE = "recordings";

let config = {
  sampleRate: 44100,
  windowSize: 2048,
  channels: 1,
  historySeconds: 4,
  calibrationSeconds: 4,
  maxFrequency: 10000,
};

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function colorForDb(db) {
  const t = clamp((db - minDb) / (maxDb - minDb), 0, 1);

  if (t < 0.35) {
    const p = t / 0.35;
    return [
      Math.round(7 + p * 10),
      Math.round(16 + p * 87),
      Math.round(20 + p * 80),
    ];
  }

  if (t < 0.74) {
    const p = (t - 0.35) / 0.39;
    return [
      Math.round(17 + p * 223),
      Math.round(103 + p * 109),
      Math.round(100 + p * -22),
    ];
  }

  const p = (t - 0.74) / 0.26;
  return [
    Math.round(240 + p * 4),
    Math.round(212 + p * -121),
    Math.round(78 + p * -10),
  ];
}

function numericInput(input, fallback) {
  const parsed = Number(input.value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizedInput(input, fallback, low, high) {
  const value = Math.round(clamp(numericInput(input, fallback), low, high));
  input.value = String(value);
  return value;
}

function readSettings() {
  const saved = JSON.parse(localStorage.getItem("piezoBrowserSettings") || "{}");
  const hasLoadedDeviceOptions = [...deviceSelectEl.options].some((option) => option.dataset.realAudioInput === "true");
  config.sampleRate = sanitizedInput(sampleRateInputEl, 44100, 8000, 192000);
  config.windowSize = sanitizedInput(windowSizeInputEl, 2048, 128, 32768);
  config.historySeconds = clamp(numericInput(historyInputEl, 4), 0.25, 30);
  config.calibrationSeconds = clamp(numericInput(calibrationInputEl, 4), 0.25, 20);
  config.maxFrequency = clamp(numericInput(maxFrequencyInputEl, 10000), 1, 96000);
  localStorage.setItem(
    "piezoBrowserSettings",
    JSON.stringify({
      sampleRate: String(config.sampleRate),
      windowSize: String(config.windowSize),
      channels: channelsInputEl.value,
      historySeconds: String(config.historySeconds),
      maxFrequency: String(config.maxFrequency),
      calibrationSeconds: String(config.calibrationSeconds),
      deviceId: hasLoadedDeviceOptions ? deviceSelectEl.value : saved.deviceId || "",
    })
  );
}

function restoreSettings() {
  const saved = JSON.parse(localStorage.getItem("piezoBrowserSettings") || "{}");
  if (saved.sampleRate) {
    sampleRateInputEl.value = saved.sampleRate;
  }
  if (saved.windowSize) {
    windowSizeInputEl.value = saved.windowSize;
  }
  if (saved.channels) {
    channelsInputEl.value = saved.channels;
  }
  if (saved.historySeconds) {
    historyInputEl.value = saved.historySeconds;
  }
  if (saved.maxFrequency) {
    maxFrequencyInputEl.value = saved.maxFrequency;
  }
  if (saved.calibrationSeconds) {
    calibrationInputEl.value = saved.calibrationSeconds;
  }
  readSettings();
}

function setStatus(text) {
  lastLiveStatus = text;
  statusEl.textContent = isPaused ? "一時停止中" : text;
}

function openRecordingDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDING_STORE)) {
        db.createObjectStore(RECORDING_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveRecording(recording) {
  const db = await openRecordingDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(RECORDING_STORE, "readwrite");
    transaction.objectStore(RECORDING_STORE).put(recording);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

function flattenRecordingChunks(chunks, channels, frames) {
  const output = new Float32Array(frames * channels);
  let frameOffset = 0;

  for (const chunk of chunks) {
    const chunkFrames = chunk[0]?.length || 0;
    for (let frame = 0; frame < chunkFrames; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        output[(frameOffset + frame) * channels + channel] = chunk[channel]?.[frame] || 0;
      }
    }
    frameOffset += chunkFrames;
  }

  return output;
}

function updateRecordingStatus() {
  if (!isRecording) {
    return;
  }
  const elapsed = (performance.now() - recordingStartedAt) / 1000;
  recordStatusEl.textContent = `${elapsed.toFixed(1)}s`;
}

function setRecordingActive(active) {
  recordPanelEl?.classList.toggle("recordingActive", active);
  recordStatusEl.classList.toggle("recordingActive", active);
}

function setRecordingUi() {
  recordToggleButtonEl.disabled = recordingRequestPending;
  recordToggleButtonEl.classList.toggle("recordingActive", isRecording);
  recordToggleButtonEl.classList.toggle("recordStartAction", !isRecording);
  recordToggleButtonEl.classList.toggle("recordStopAction", isRecording);
  recordToggleButtonEl.innerHTML = isRecording ? recordStopIcon : recordStartIcon;
  recordToggleButtonEl.title = isRecording ? "録音を停止" : "録音を開始";
  recordToggleButtonEl.setAttribute("aria-label", isRecording ? "録音を停止" : "録音を開始");
  setRecordingActive(isRecording);
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    draw();
  }
}

function maxVisibleColumns() {
  const frameSeconds = config.windowSize / config.sampleRate;
  return Math.max(1, Math.ceil(config.historySeconds / frameSeconds));
}

function trimColumns() {
  const maxColumns = maxVisibleColumns();
  if (columns.length > maxColumns) {
    columns = columns.slice(columns.length - maxColumns);
  }
}

function syncFrequencyLabels() {
  if (frequencies.length === 0) {
    freqLowEl.textContent = "0 Hz";
    freqMidEl.textContent = "-- Hz";
    freqHighEl.textContent = "-- Hz";
    return;
  }

  const low = frequencies[0];
  const high = frequencies[frequencies.length - 1];
  const mid = (low + high) / 2;
  freqLowEl.textContent = `${Math.round(low).toLocaleString()} Hz`;
  freqMidEl.textContent = `${Math.round(mid).toLocaleString()} Hz`;
  freqHighEl.textContent = `${Math.round(high).toLocaleString()} Hz`;
}

function drawChannel(channelIndex, yStart, channelHeight) {
  const width = canvas.width;
  const bins = frequencies.length;
  const maxColumns = maxVisibleColumns();
  const columnWidth = Math.max(1, width / maxColumns);
  const firstColumn = Math.max(0, maxColumns - columns.length);

  ctx.fillStyle = "#090b0c";
  ctx.fillRect(0, yStart, width, channelHeight);

  for (let x = 0; x < columns.length; x += 1) {
    const magnitudes = columns[x][channelIndex] || [];
    const drawX = Math.floor((firstColumn + x) * columnWidth);
    const drawW = Math.ceil(columnWidth);

    for (let bin = 0; bin < bins; bin += 1) {
      const y = yStart + channelHeight - Math.ceil(((bin + 1) / bins) * channelHeight);
      const nextY = yStart + channelHeight - Math.ceil((bin / bins) * channelHeight);
      const [r, g, b] = colorForDb(magnitudes[bin] ?? minDb);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(drawX, y, drawW, Math.max(1, nextY - y));
    }
  }

  if (config.channels > 1) {
    ctx.fillStyle = "rgba(241, 243, 238, 0.75)";
    ctx.font = `${Math.max(11, Math.floor(canvas.height * 0.018))}px system-ui`;
    ctx.fillText(channelIndex === 0 ? "L" : "R", 12, yStart + 22);
  }
}

function draw() {
  resizeCanvas();
  const width = canvas.width;
  const height = canvas.height;

  ctx.fillStyle = "#090b0c";
  ctx.fillRect(0, 0, width, height);

  if (columns.length === 0 || frequencies.length === 0) {
    ctx.fillStyle = "#bac3be";
    ctx.font = `${Math.max(14, Math.floor(height * 0.035))}px system-ui`;
    ctx.fillText(statusEl.textContent || "入力待機中", 22, 44);
    return;
  }

  const channelHeight = Math.floor(height / config.channels);
  for (let channel = 0; channel < config.channels; channel += 1) {
    drawChannel(channel, channel * channelHeight, channelHeight);
  }

  if (config.channels > 1) {
    ctx.strokeStyle = "rgba(241, 243, 238, 0.32)";
    ctx.lineWidth = Math.max(1, window.devicePixelRatio || 1);
    ctx.beginPath();
    ctx.moveTo(0, channelHeight);
    ctx.lineTo(width, channelHeight);
    ctx.stroke();
  }
}

function resetCalibration() {
  const binCount = frequencies.length;
  noiseSums = Array.from({ length: config.channels }, () => new Float32Array(binCount));
  noiseFloor = null;
  calibrationFramesSeen = 0;
  columns = [];
  setStatus("キャリブレーション中 0%");
  draw();
}

function buildFrequencies() {
  const nyquist = config.sampleRate / 2;
  const high = Math.min(config.maxFrequency, nyquist);
  const rawBinCount = Math.floor(config.windowSize / 2) + 1;
  const result = [];
  const bins = [];

  for (let bin = 0; bin < rawBinCount; bin += 1) {
    const frequency = (bin * config.sampleRate) / config.windowSize;
    if (frequency <= high) {
      result.push(frequency);
      bins.push(bin);
    }
  }

  frequencies = result;
  frequencyBins = bins;
  analysisWindow = new Float32Array(config.windowSize);
  for (let i = 0; i < config.windowSize; i += 1) {
    analysisWindow[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (config.windowSize - 1));
  }
  syncFrequencyLabels();
}

function calibrationFramesNeeded() {
  return Math.max(1, Math.ceil((config.calibrationSeconds * config.sampleRate) / config.windowSize));
}

function magnitudeToDb(magnitude) {
  return 20 * Math.log10(Math.max(magnitude, 1.0e-10));
}

function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0;
}

function fftReal(input) {
  const n = input.length;
  const real = new Float32Array(input);
  const imag = new Float32Array(n);

  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wlenR = Math.cos(angle);
    const wlenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < len / 2; j += 1) {
        const uR = real[i + j];
        const uI = imag[i + j];
        const vR = real[i + j + len / 2] * wr - imag[i + j + len / 2] * wi;
        const vI = real[i + j + len / 2] * wi + imag[i + j + len / 2] * wr;
        real[i + j] = uR + vR;
        imag[i + j] = uI + vI;
        real[i + j + len / 2] = uR - vR;
        imag[i + j + len / 2] = uI - vI;
        const nextWr = wr * wlenR - wi * wlenI;
        wi = wr * wlenI + wi * wlenR;
        wr = nextWr;
      }
    }
  }

  return { real, imag };
}

function dftMagnitude(frame, bin) {
  let real = 0;
  let imag = 0;
  const angleStep = (-2 * Math.PI * bin) / frame.length;
  for (let i = 0; i < frame.length; i += 1) {
    const angle = angleStep * i;
    real += frame[i] * Math.cos(angle);
    imag += frame[i] * Math.sin(angle);
  }
  return Math.hypot(real, imag);
}

function spectrumForFrame(samples) {
  const frame = new Float32Array(config.windowSize);
  for (let i = 0; i < config.windowSize; i += 1) {
    frame[i] = samples[i] * analysisWindow[i];
  }

  if (isPowerOfTwo(config.windowSize)) {
    const spectrum = fftReal(frame);
    return frequencyBins.map((bin) => Math.hypot(spectrum.real[bin], spectrum.imag[bin]) / (config.windowSize / 2));
  }

  return frequencyBins.map((bin) => dftMagnitude(frame, bin) / (config.windowSize / 2));
}

function appendChannelBuffer(channel, samples) {
  const current = spectrumBuffers[channel] || new Float32Array(0);
  const next = new Float32Array(current.length + samples.length);
  next.set(current);
  next.set(samples, current.length);
  spectrumBuffers[channel] = next;
}

function consumeSpectrumFrame() {
  if (spectrumBuffers.length === 0 || spectrumBuffers.some((buffer) => buffer.length < config.windowSize)) {
    return null;
  }

  const frame = spectrumBuffers.map((buffer, channel) => {
    const samples = buffer.slice(0, config.windowSize);
    spectrumBuffers[channel] = buffer.slice(config.windowSize);
    return samples;
  });

  return frame;
}

function makeSpectrumColumn(frame) {
  const column = [];

  for (let channel = 0; channel < frame.length; channel += 1) {
    const magnitudes = spectrumForFrame(frame[channel]);
    const output = new Array(frequencies.length);

    for (let bin = 0; bin < frequencies.length; bin += 1) {
      const magnitude = magnitudes[bin];
      const db = magnitudeToDb(magnitude);

      if (noiseFloor === null) {
        noiseSums[channel][bin] += magnitude;
        output[bin] = db;
      } else {
        output[bin] = magnitudeToDb(magnitude - noiseFloor[channel][bin]);
      }
    }

    column.push(output);
  }

  if (noiseFloor === null) {
    calibrationFramesSeen += 1;
    const progress = calibrationFramesSeen / calibrationFramesNeeded();
    if (calibrationFramesSeen >= calibrationFramesNeeded()) {
      noiseFloor = noiseSums.map((channelSums) => {
        const floor = new Float32Array(channelSums.length);
        for (let bin = 0; bin < channelSums.length; bin += 1) {
          floor[bin] = channelSums[bin] / calibrationFramesSeen;
        }
        return floor;
      });
      setStatus("ノイズキャンセル適用中");
    } else {
      setStatus(`キャリブレーション中 ${Math.round(progress * 100)}%`);
    }
  }

  return column;
}

function processSpectrumFrames() {
  if (isPaused) {
    spectrumBuffers = spectrumBuffers.map((buffer) => buffer.slice(Math.max(0, buffer.length - config.windowSize)));
    return;
  }
  if (frequencyBins.length === 0) {
    return;
  }

  let frame = consumeSpectrumFrame();
  while (frame) {
    columns.push(makeSpectrumColumn(frame));
    trimColumns();
    frame = consumeSpectrumFrame();
  }
  draw();
}

function stopStream() {
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  if (splitterNode) {
    splitterNode.disconnect();
    splitterNode = null;
  }

  if (recorderNode) {
    recorderNode.disconnect();
    recorderNode.onaudioprocess = null;
    recorderNode = null;
  }

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
    mediaStream = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  spectrumBuffers = [];

  if (isRecording) {
    isRecording = false;
    recordingChunks = [];
    recordingFrameCount = 0;
    recordStatusEl.textContent = "録音を中断しました";
  }
  setRecordingUi();
}

async function loadDevices(preferredDeviceId = null) {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((device) => device.kind === "audioinput");
  const saved = JSON.parse(localStorage.getItem("piezoBrowserSettings") || "{}");
  const selectedDeviceId = preferredDeviceId ?? deviceSelectEl.value ?? saved.deviceId ?? "";
  const canIdentifyDevices = Boolean(mediaStream) || inputs.some((device) => device.label || device.deviceId);

  deviceSelectEl.innerHTML = "";

  if (!canIdentifyDevices) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "開始後に読み込み";
    deviceSelectEl.appendChild(option);
    return;
  }

  for (const [index, device] of inputs.entries()) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.dataset.audioInput = "true";
    option.dataset.realAudioInput = device.deviceId ? "true" : "false";
    option.textContent = device.label || `Audio input ${index + 1}`;
    deviceSelectEl.appendChild(option);
  }

  if (inputs.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "入力デバイスなし";
    deviceSelectEl.appendChild(option);
    return;
  }

  const match = inputs.find((device) => device.deviceId === selectedDeviceId);
  if (match) {
    deviceSelectEl.value = match.deviceId;
  } else if (saved.deviceId && inputs.some((device) => device.deviceId === saved.deviceId)) {
    deviceSelectEl.value = saved.deviceId;
  }
}

function requestedChannelCount(track) {
  const selected = channelsInputEl.value;
  if (selected === "1" || selected === "2") {
    return Number(selected);
  }

  const settings = track.getSettings?.() || {};
  return settings.channelCount && settings.channelCount >= 2 ? 2 : 1;
}

async function requestAudioStream(selectedDevice, baseConstraints) {
  if (!selectedDevice) {
    return navigator.mediaDevices.getUserMedia({ audio: baseConstraints });
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        ...baseConstraints,
        deviceId: { exact: selectedDevice },
      },
    });
  } catch (error) {
    if (!["OverconstrainedError", "NotFoundError", "NotReadableError"].includes(error.name)) {
      throw error;
    }
    return navigator.mediaDevices.getUserMedia({
      audio: {
        ...baseConstraints,
        deviceId: { ideal: selectedDevice },
      },
    });
  }
}

function connectAnalyserGraph() {
  sourceNode = audioContext.createMediaStreamSource(mediaStream);

  const [track] = mediaStream.getAudioTracks();
  config.channels = requestedChannelCount(track);
  config.sampleRate = audioContext.sampleRate;
  sampleRateInputEl.value = String(Math.round(config.sampleRate));
  config.windowSize = sanitizedInput(windowSizeInputEl, config.windowSize, 128, 32768);

  buildFrequencies();
  spectrumBuffers = Array.from({ length: config.channels }, () => new Float32Array(0));
  connectRecorderNode();
  resetCalibration();
}

function connectRecorderNode() {
  if (!sourceNode || !audioContext) {
    return;
  }

  recorderNode = audioContext.createScriptProcessor(4096, config.channels, config.channels);
  recorderNode.onaudioprocess = (event) => {
    const input = event.inputBuffer;
    const frames = input.length;
    const chunk = [];
    for (let channel = 0; channel < config.channels; channel += 1) {
      const sourceChannel = Math.min(channel, input.numberOfChannels - 1);
      const samples = new Float32Array(input.getChannelData(sourceChannel));
      appendChannelBuffer(channel, samples);
      chunk.push(samples);
    }
    processSpectrumFrames();

    if (isRecording) {
      recordingChunks.push(chunk);
      recordingFrameCount += frames;
    }
  };

  sourceNode.connect(recorderNode);
  recorderNode.connect(audioContext.destination);
}

async function startStream() {
  if (startStreamPromise) {
    return startStreamPromise;
  }

  startStreamPromise = startStreamInternal().finally(() => {
    startStreamPromise = null;
  });
  return startStreamPromise;
}

async function startStreamInternal() {
  const BrowserAudioContext = window.AudioContext || window.webkitAudioContext;
  if (!navigator.mediaDevices?.getUserMedia || !BrowserAudioContext) {
    setStatus("このブラウザはマイク入力に対応していません");
    return false;
  }

  readSettings();
  stopStream();

  const selectedDevice = deviceSelectEl.value;
  try {
    setStatus("マイク許可を待っています");
    const audioConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: { ideal: config.sampleRate },
    };

    mediaStream = await requestAudioStream(selectedDevice, audioConstraints);
    try {
      audioContext = new BrowserAudioContext({ sampleRate: config.sampleRate });
    } catch {
      audioContext = new BrowserAudioContext();
    }
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const [track] = mediaStream.getAudioTracks();
    await loadDevices(track?.getSettings?.().deviceId || selectedDevice);
    connectAnalyserGraph();
    startButtonEl.textContent = "再開始";
    pauseButtonEl.disabled = false;
    calibrateButtonEl.disabled = false;
    setRecordingUi();
    readSettings();
    if (deviceSelectEl.options.length <= 1) {
      setStatus("入力ソースはブラウザが公開した1件のみです");
    }
    return true;
  } catch (error) {
    stopStream();
    setStatus(`エラー: ${error.message}`);
    return false;
  }
}

function selectedDeviceLabel() {
  const option = deviceSelectEl.selectedOptions[0];
  return option?.textContent || "browser input";
}

async function startRecording() {
  if (!mediaStream || !audioContext || isRecording || recordingRequestPending) {
    if (mediaStream || audioContext || isRecording || recordingRequestPending) {
      return;
    }

    recordingRequestPending = true;
    setRecordingUi();
    recordStatusEl.textContent = "開始中";
    const started = await startStream();
    recordingRequestPending = false;
    setRecordingUi();
    if (!started || !mediaStream || !audioContext) {
      recordStatusEl.textContent = "0.0s";
      return;
    }
  }

  recordingRequestPending = true;
  isRecording = true;
  recordingStartedAt = performance.now();
  recordingFrameCount = 0;
  recordingChunks = [];
  recordStatusEl.textContent = "0.0s";
  setRecordingUi();
  clearInterval(recordingStatusTimer);
  recordingStatusTimer = setInterval(updateRecordingStatus, 100);
  recordingRequestPending = false;
  setRecordingUi();
}

async function stopRecording() {
  if (!isRecording || recordingRequestPending) {
    return;
  }

  recordingRequestPending = true;
  isRecording = false;
  clearInterval(recordingStatusTimer);
  recordStatusEl.textContent = "保存中";
  setRecordingUi();

  const chunks = recordingChunks;
  const frames = recordingFrameCount;
  recordingChunks = [];
  recordingFrameCount = 0;

  if (frames === 0) {
    recordStatusEl.textContent = "録音データなし";
    recordingRequestPending = false;
    setRecordingUi();
    return;
  }

  try {
    const pcm = flattenRecordingChunks(chunks, config.channels, frames);
    const now = new Date();
    const id = `${now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_")}_${Math.random()
      .toString(16)
      .slice(2, 10)}`;
    const recording = {
      id,
      createdAt: now.toISOString(),
      sampleRate: config.sampleRate,
      channels: config.channels,
      frames,
      durationSeconds: frames / config.sampleRate,
      deviceLabel: selectedDeviceLabel(),
      memo: "",
      pcm: pcm.buffer,
    };
    await saveRecording(recording);
    recordStatusEl.textContent = `${recording.durationSeconds.toFixed(1)}s`;
  } catch (error) {
    recordStatusEl.textContent = `保存エラー: ${error.message}`;
  }

  recordingRequestPending = false;
  setRecordingUi();
}

function toggleRecording() {
  if (recordingRequestPending) {
    return;
  }
  if (isRecording) {
    stopRecording();
    return;
  }
  startRecording();
}

function togglePause() {
  isPaused = !isPaused;
  pauseButtonEl.textContent = isPaused ? "再開" : "一時停止";
  statusEl.textContent = isPaused ? "一時停止中" : lastLiveStatus;
  draw();
}

function restartIfRunning() {
  readSettings();
  if (mediaStream) {
    startStream();
  }
}

window.addEventListener("resize", () => {
  resizeCanvas();
  draw();
});

function isEditableTarget(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function isSpaceKey(event) {
  return event.code === "Space" || event.key === " " || event.key === "Spacebar";
}

document.addEventListener(
  "keydown",
  (event) => {
    if (isSpaceKey(event) && !isEditableTarget(event.target) && !pauseButtonEl.disabled) {
      event.preventDefault();
      togglePause();
    }
  },
  { capture: true }
);

document.addEventListener(
  "keyup",
  (event) => {
    if (isSpaceKey(event) && !isEditableTarget(event.target) && !pauseButtonEl.disabled) {
      event.preventDefault();
    }
  },
  { capture: true }
);

startButtonEl.addEventListener("click", startStream);
pauseButtonEl.addEventListener("click", togglePause);
calibrateButtonEl.addEventListener("click", resetCalibration);
recordToggleButtonEl.addEventListener("click", toggleRecording);
deviceSelectEl.addEventListener("change", restartIfRunning);

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    const selectedDevice = deviceSelectEl.value;
    loadDevices(selectedDevice).catch(() => {
      setStatus("入力ソースの更新に失敗しました");
    });
  });
}

for (const input of [
  sampleRateInputEl,
  windowSizeInputEl,
  channelsInputEl,
  historyInputEl,
  maxFrequencyInputEl,
  calibrationInputEl,
]) {
  input.addEventListener("change", restartIfRunning);
}

restoreSettings();
resizeCanvas();
draw();
setRecordingUi();

if (window.isSecureContext) {
  loadDevices().catch(() => {
    setStatus("開始後に入力ソースを読み込みます");
  });
} else {
  setStatus("HTTPSまたはlocalhostで開いてください");
}
