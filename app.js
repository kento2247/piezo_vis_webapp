const canvas = document.getElementById("spectrogram");
const ctx = canvas.getContext("2d", { alpha: false });

const statusEl = document.getElementById("status");
const startButtonEl = document.getElementById("startButton");
const pauseButtonEl = document.getElementById("pauseButton");
const calibrateButtonEl = document.getElementById("calibrateButton");
const recordStartButtonEl = document.getElementById("recordStartButton");
const recordStopButtonEl = document.getElementById("recordStopButton");
const recordStatusEl = document.getElementById("recordStatus");
const deviceSelectEl = document.getElementById("deviceSelect");
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
let analyserNodes = [];
let frequencyBuffers = [];
let animationId = null;
let columns = [];
let frequencies = [];
let noiseSums = [];
let noiseFloor = null;
let calibrationFramesSeen = 0;
let lastFrameAt = 0;
let isPaused = false;
let lastLiveStatus = "開始を押してください";
let isRecording = false;
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

function readSettings() {
  config.windowSize = Number(windowSizeInputEl.value);
  config.historySeconds = clamp(numericInput(historyInputEl, 4), 0.25, 30);
  config.calibrationSeconds = clamp(numericInput(calibrationInputEl, 4), 0.25, 20);
  config.maxFrequency = clamp(numericInput(maxFrequencyInputEl, 10000), 1, 96000);
  localStorage.setItem(
    "piezoBrowserSettings",
    JSON.stringify({
      windowSize: String(config.windowSize),
      channels: channelsInputEl.value,
      historySeconds: String(config.historySeconds),
      maxFrequency: String(config.maxFrequency),
      calibrationSeconds: String(config.calibrationSeconds),
      deviceId: deviceSelectEl.value,
    })
  );
}

function restoreSettings() {
  const saved = JSON.parse(localStorage.getItem("piezoBrowserSettings") || "{}");
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
  recordStatusEl.textContent = `録音中 ${elapsed.toFixed(1)}s`;
}

function setRecordingUi() {
  recordStartButtonEl.disabled = !mediaStream || isRecording;
  recordStopButtonEl.disabled = !isRecording;
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
  const rawBinCount = config.windowSize / 2;
  const result = [];

  for (let bin = 0; bin < rawBinCount; bin += 1) {
    const frequency = (bin * config.sampleRate) / config.windowSize;
    if (frequency <= high) {
      result.push(frequency);
    }
  }

  frequencies = result;
  syncFrequencyLabels();
}

function calibrationFramesNeeded() {
  return Math.max(1, Math.ceil((config.calibrationSeconds * config.sampleRate) / config.windowSize));
}

function dbToMagnitude(db) {
  return 10 ** (db / 20);
}

function magnitudeToDb(magnitude) {
  return 20 * Math.log10(Math.max(magnitude, 1.0e-10));
}

function readSpectrumColumn() {
  const visibleBins = frequencies.length;
  const column = [];

  for (let channel = 0; channel < analyserNodes.length; channel += 1) {
    const buffer = frequencyBuffers[channel];
    analyserNodes[channel].getFloatFrequencyData(buffer);
    const output = new Array(visibleBins);

    for (let bin = 0; bin < visibleBins; bin += 1) {
      const db = Number.isFinite(buffer[bin]) ? buffer[bin] : minDb;
      const magnitude = dbToMagnitude(db);

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

function animationLoop(now) {
  animationId = requestAnimationFrame(animationLoop);

  if (isPaused || analyserNodes.length === 0) {
    return;
  }

  const frameMs = (config.windowSize / config.sampleRate) * 1000;
  if (now - lastFrameAt < frameMs) {
    return;
  }

  lastFrameAt = now;
  columns.push(readSpectrumColumn());
  trimColumns();
  draw();
}

function stopStream() {
  if (animationId !== null) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  analyserNodes = [];
  frequencyBuffers = [];

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

  if (isRecording) {
    isRecording = false;
    recordingChunks = [];
    recordingFrameCount = 0;
    recordStatusEl.textContent = "録音を中断しました";
  }
  setRecordingUi();
}

async function loadDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((device) => device.kind === "audioinput");
  const saved = JSON.parse(localStorage.getItem("piezoBrowserSettings") || "{}");

  deviceSelectEl.innerHTML = "";
  for (const [index, device] of inputs.entries()) {
    const option = document.createElement("option");
    option.value = device.deviceId;
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

  if (saved.deviceId && inputs.some((device) => device.deviceId === saved.deviceId)) {
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

function connectAnalyserGraph() {
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  splitterNode = audioContext.createChannelSplitter(2);
  sourceNode.connect(splitterNode);

  const [track] = mediaStream.getAudioTracks();
  config.channels = requestedChannelCount(track);
  config.sampleRate = audioContext.sampleRate;
  config.windowSize = Number(windowSizeInputEl.value);

  buildFrequencies();
  analyserNodes = [];
  frequencyBuffers = [];

  for (let channel = 0; channel < config.channels; channel += 1) {
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = config.windowSize;
    analyser.minDecibels = minDb;
    analyser.maxDecibels = maxDb;
    analyser.smoothingTimeConstant = 0;

    try {
      splitterNode.connect(analyser, channel);
    } catch {
      if (channel === 0) {
        sourceNode.connect(analyser);
      } else {
        break;
      }
    }

    analyserNodes.push(analyser);
    frequencyBuffers.push(new Float32Array(analyser.frequencyBinCount));
  }

  config.channels = analyserNodes.length || 1;
  connectRecorderNode();
  resetCalibration();
}

function connectRecorderNode() {
  if (!sourceNode || !audioContext) {
    return;
  }

  recorderNode = audioContext.createScriptProcessor(4096, config.channels, config.channels);
  recorderNode.onaudioprocess = (event) => {
    if (!isRecording) {
      return;
    }

    const input = event.inputBuffer;
    const frames = input.length;
    const chunk = [];
    for (let channel = 0; channel < config.channels; channel += 1) {
      const sourceChannel = Math.min(channel, input.numberOfChannels - 1);
      chunk.push(new Float32Array(input.getChannelData(sourceChannel)));
    }
    recordingChunks.push(chunk);
    recordingFrameCount += frames;
  };

  sourceNode.connect(recorderNode);
  recorderNode.connect(audioContext.destination);
}

async function startStream() {
  const BrowserAudioContext = window.AudioContext || window.webkitAudioContext;
  if (!navigator.mediaDevices?.getUserMedia || !BrowserAudioContext) {
    setStatus("このブラウザはマイク入力に対応していません");
    return;
  }

  readSettings();
  stopStream();

  try {
    setStatus("マイク許可を待っています");
    const selectedDevice = deviceSelectEl.value;
    const audioConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };

    if (selectedDevice) {
      audioConstraints.deviceId = { exact: selectedDevice };
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    audioContext = new BrowserAudioContext();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    await loadDevices();
    connectAnalyserGraph();
    startButtonEl.textContent = "再開始";
    pauseButtonEl.disabled = false;
    calibrateButtonEl.disabled = false;
    recordStartButtonEl.disabled = false;
    setRecordingUi();
    lastFrameAt = 0;
    animationId = requestAnimationFrame(animationLoop);
  } catch (error) {
    stopStream();
    setStatus(`エラー: ${error.message}`);
  }
}

function selectedDeviceLabel() {
  const option = deviceSelectEl.selectedOptions[0];
  return option?.textContent || "browser input";
}

function startRecording() {
  if (!mediaStream || !audioContext || isRecording) {
    return;
  }

  isRecording = true;
  recordingStartedAt = performance.now();
  recordingFrameCount = 0;
  recordingChunks = [];
  recordStatusEl.textContent = "録音中 0.0s";
  setRecordingUi();
  clearInterval(recordingStatusTimer);
  recordingStatusTimer = setInterval(updateRecordingStatus, 250);
}

async function stopRecording() {
  if (!isRecording) {
    return;
  }

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
      pcm: pcm.buffer,
    };
    await saveRecording(recording);
    recordStatusEl.textContent = `保存完了 ${recording.durationSeconds.toFixed(1)}s`;
  } catch (error) {
    recordStatusEl.textContent = `保存エラー: ${error.message}`;
  }

  setRecordingUi();
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
recordStartButtonEl.addEventListener("click", startRecording);
recordStopButtonEl.addEventListener("click", stopRecording);
deviceSelectEl.addEventListener("change", restartIfRunning);

for (const input of [
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
