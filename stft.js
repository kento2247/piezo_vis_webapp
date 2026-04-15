const stftCanvas = document.getElementById("stftCanvas");
const stftCtx = stftCanvas.getContext("2d", { alpha: false });
const stftStatusEl = document.getElementById("stftStatus");
const recordingItemsEl = document.getElementById("recordingItems");
const stftWindowInputEl = document.getElementById("stftWindowInput");
const stftHopInputEl = document.getElementById("stftHopInput");
const stftMinFrequencyInputEl = document.getElementById("stftMinFrequencyInput");
const stftMaxFrequencyInputEl = document.getElementById("stftMaxFrequencyInput");
const refreshButtonEl = document.getElementById("refreshButton");
const downloadImageButtonEl = document.getElementById("downloadImageButton");
const downloadWavButtonEl = document.getElementById("downloadWavButton");
const stftFreqHighEl = document.getElementById("stftFreqHigh");
const stftFreqMidEl = document.getElementById("stftFreqMid");
const stftFreqLowEl = document.getElementById("stftFreqLow");
const dbStartInputEl = document.getElementById("dbStartInput");
const dbEndInputEl = document.getElementById("dbEndInput");
const dbStartValueEl = document.getElementById("dbStartValue");
const dbEndValueEl = document.getElementById("dbEndValue");
const legendDbStartEl = document.getElementById("legendDbStart");
const legendDbEndEl = document.getElementById("legendDbEnd");

let dbStart = -95;
let dbEnd = -15;
const dbScaleStart = -140;
const dbScaleEnd = 0;
const DB_NAME = "piezoVisualizerRecordings";
const DB_VERSION = 1;
const RECORDING_STORE = "recordings";

let recordings = [];
let selectedRecordingId = null;
let selectedRecording = null;
let stftPayload = null;
let memoSaveTimers = new Map();
let stftReloadTimer = null;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function scaleColorForDb(db) {
  const t = clamp((db - dbScaleStart) / (dbScaleEnd - dbScaleStart), 0, 1);

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

function colorForDb(db) {
  if (db < dbStart || db > dbEnd) {
    return null;
  }
  return scaleColorForDb(db);
}

function syncDbRangeControls() {
  const start = Math.min(Number(dbStartInputEl.value), Number(dbEndInputEl.value) - 1);
  const end = Math.max(Number(dbEndInputEl.value), start + 1);
  dbStart = clamp(start, -140, -1);
  dbEnd = clamp(end, dbStart + 1, 0);

  dbStartInputEl.value = String(dbStart);
  dbEndInputEl.value = String(dbEnd);
  dbStartValueEl.textContent = `${dbStart} dB`;
  dbEndValueEl.textContent = `${dbEnd} dB`;
  legendDbStartEl.textContent = `${dbScaleStart} dB`;
  legendDbEndEl.textContent = `${dbScaleEnd} dB`;
}

function updateDbRange() {
  syncDbRangeControls();
  drawStft();
}

function setStatus(message) {
  stftStatusEl.textContent = message;
}

function numericInput(input, fallback) {
  const parsed = Number(input.value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatDuration(seconds) {
  return `${Number(seconds || 0).toFixed(2)}s`;
}

function selectedFrequencyRange() {
  const minFrequency = Math.max(0, numericInput(stftMinFrequencyInputEl, 0));
  const maxFrequency = Math.max(minFrequency + 1, numericInput(stftMaxFrequencyInputEl, 10000));
  stftMinFrequencyInputEl.value = String(minFrequency);
  stftMaxFrequencyInputEl.value = String(maxFrequency);
  return { minFrequency, maxFrequency };
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

async function getAllRecordings() {
  const db = await openRecordingDb();
  const result = await new Promise((resolve, reject) => {
    const transaction = db.transaction(RECORDING_STORE, "readonly");
    const request = transaction.objectStore(RECORDING_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return result.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function putRecording(recording) {
  const db = await openRecordingDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(RECORDING_STORE, "readwrite");
    transaction.objectStore(RECORDING_STORE).put(recording);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

function setExportEnabled(hasStft) {
  downloadImageButtonEl.disabled = !hasStft;
  downloadWavButtonEl.disabled = !selectedRecording;
}

function renderRecordingList() {
  recordingItemsEl.innerHTML = "";

  if (recordings.length === 0) {
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = "録音履歴はまだありません";
    recordingItemsEl.appendChild(empty);
    setExportEnabled(false);
    return;
  }

  for (const recording of recordings) {
    const item = document.createElement("article");
    item.className = "recordingItem";
    if (recording.id === selectedRecordingId) {
      item.classList.add("active");
    }

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "recordingSelect";

    const title = document.createElement("span");
    title.className = "recordingTitle";
    title.textContent = new Date(recording.createdAt).toLocaleString();

    const meta = document.createElement("span");
    meta.className = "recordingMeta";
    meta.textContent = `${formatDuration(recording.durationSeconds)} / ${recording.sampleRate} Hz / ${recording.channels}ch`;

    const device = document.createElement("span");
    device.className = "recordingDevice";
    device.textContent = recording.deviceLabel;

    const memoLabel = document.createElement("label");
    memoLabel.className = "memoEditor";

    const memoTitle = document.createElement("span");
    memoTitle.textContent = "メモ";

    const memoInput = document.createElement("textarea");
    memoInput.value = recording.memo || "";
    memoInput.rows = 3;
    memoInput.placeholder = "タスク名、条件、メモ";
    memoInput.addEventListener("input", () => scheduleMemoSave(recording.id, memoInput.value));

    selectButton.append(title, meta, device);
    selectButton.addEventListener("click", () => selectRecording(recording.id));
    memoLabel.append(memoTitle, memoInput);
    item.append(selectButton, memoLabel);
    recordingItemsEl.appendChild(item);
  }
}

function updateLocalMemo(recordingId, memo) {
  recordings = recordings.map((recording) =>
    recording.id === recordingId ? { ...recording, memo } : recording
  );
  if (selectedRecording?.id === recordingId) {
    selectedRecording.memo = memo;
  }
  if (stftPayload?.recording?.id === recordingId) {
    stftPayload.recording.memo = memo;
  }
}

async function saveMemo(recordingId, memo) {
  const recording = recordings.find((item) => item.id === recordingId);
  if (!recording) {
    return;
  }
  const updated = { ...recording, memo: memo.slice(0, 2000) };
  await putRecording(updated);
  updateLocalMemo(recordingId, updated.memo);
  setStatus("メモを保存しました");
}

function scheduleMemoSave(recordingId, memo) {
  updateLocalMemo(recordingId, memo);
  clearTimeout(memoSaveTimers.get(recordingId));
  memoSaveTimers.set(
    recordingId,
    setTimeout(async () => {
      try {
        await saveMemo(recordingId, memo);
      } catch (error) {
        setStatus(`メモ保存エラー: ${error.message}`);
      }
    }, 500)
  );
}

async function loadRecordings() {
  recordings = await getAllRecordings();
  if (!selectedRecordingId && recordings.length > 0) {
    selectedRecordingId = recordings[0].id;
  }
  if (selectedRecordingId && !recordings.some((recording) => recording.id === selectedRecordingId)) {
    selectedRecordingId = recordings[0]?.id || null;
  }
  selectedRecording = recordings.find((recording) => recording.id === selectedRecordingId) || null;
  renderRecordingList();
  setExportEnabled(false);
}

function resizeCanvas() {
  const rect = stftCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));

  if (stftCanvas.width !== width || stftCanvas.height !== height) {
    stftCanvas.width = width;
    stftCanvas.height = height;
    drawStft();
  }
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

function channelFrame(pcm, start, channel, channels, window) {
  const frame = new Float32Array(window.length);
  for (let i = 0; i < window.length; i += 1) {
    frame[i] = pcm[(start + i) * channels + channel] * window[i];
  }
  return frame;
}

function computeStft(recording) {
  const windowSize = Number(stftWindowInputEl.value);
  const hopSize = Math.max(32, Math.round(numericInput(stftHopInputEl, 512)));
  const { minFrequency, maxFrequency } = selectedFrequencyRange();
  const pcm = new Float32Array(recording.pcm);

  if (recording.frames < windowSize) {
    throw new Error("録音がwindowより短いです");
  }

  const nyquist = recording.sampleRate / 2;
  const high = Math.min(maxFrequency, nyquist);
  const binCount = windowSize / 2 + 1;
  const frequencies = [];
  const frequencyBins = [];
  for (let bin = 0; bin < binCount; bin += 1) {
    const frequency = (bin * recording.sampleRate) / windowSize;
    if (frequency >= minFrequency && frequency <= high) {
      frequencies.push(frequency);
      frequencyBins.push(bin);
    }
  }

  const window = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (windowSize - 1));
  }

  let starts = [];
  for (let start = 0; start <= recording.frames - windowSize; start += hopSize) {
    starts.push(start);
  }
  if (starts.length > 700) {
    starts = Array.from({ length: 700 }, (_, index) =>
      starts[Math.round((index / 699) * (starts.length - 1))]
    );
  }

  const columns = starts.map((start) => {
    const channelColumns = [];
    for (let channel = 0; channel < recording.channels; channel += 1) {
      const frame = channelFrame(pcm, start, channel, recording.channels, window);
      const spectrum = fftReal(frame);
      const magnitudes = new Array(frequencies.length);
      for (let index = 0; index < frequencyBins.length; index += 1) {
        const bin = frequencyBins[index];
        const magnitude =
          Math.hypot(spectrum.real[bin], spectrum.imag[bin]) / (windowSize / 2);
        magnitudes[index] = 20 * Math.log10(Math.max(magnitude, 1.0e-10));
      }
      channelColumns.push(magnitudes);
    }
    return channelColumns;
  });

  return {
    recording,
    windowSize,
    hopSize,
    channels: recording.channels,
    frequencies,
    times: starts.map((start) => start / recording.sampleRate),
    magnitudesDb: columns,
  };
}

async function loadSelectedStft() {
  clearTimeout(stftReloadTimer);
  if (!selectedRecording) {
    stftPayload = null;
    setExportEnabled(false);
    drawStft();
    return;
  }

  stftPayload = null;
  setExportEnabled(false);
  setStatus("STFT計算中");
  await new Promise((resolve) => setTimeout(resolve, 0));
  stftPayload = computeStft(selectedRecording);
  const duration = formatDuration(selectedRecording.durationSeconds);
  setStatus(`${new Date(selectedRecording.createdAt).toLocaleString()} / ${duration}`);
  updateAxis();
  drawStft();
  setExportEnabled(true);
}

async function selectRecording(recordingId) {
  selectedRecordingId = recordingId;
  selectedRecording = recordings.find((recording) => recording.id === recordingId) || null;
  renderRecordingList();
  try {
    await loadSelectedStft();
  } catch (error) {
    setStatus(`STFTエラー: ${error.message}`);
    setExportEnabled(false);
  }
}

function updateAxis() {
  const frequencies = stftPayload?.frequencies || [];
  if (frequencies.length === 0) {
    stftFreqHighEl.textContent = "-- Hz";
    stftFreqMidEl.textContent = "-- Hz";
    stftFreqLowEl.textContent = "0 Hz";
    return;
  }

  const low = frequencies[0];
  const high = frequencies[frequencies.length - 1];
  const mid = (low + high) / 2;
  stftFreqLowEl.textContent = `${Math.round(low).toLocaleString()} Hz`;
  stftFreqMidEl.textContent = `${Math.round(mid).toLocaleString()} Hz`;
  stftFreqHighEl.textContent = `${Math.round(high).toLocaleString()} Hz`;
}

function drawChannel(columns, channelIndex, yStart, channelHeight) {
  const width = stftCanvas.width;
  const frequencies = stftPayload.frequencies || [];
  const lowFrequency = frequencies[0] || 0;
  const highFrequency = frequencies[frequencies.length - 1] || 1;
  const frequencySpan = Math.max(1, highFrequency - lowFrequency);
  const columnWidth = Math.max(1, width / Math.max(1, columns.length));

  for (let x = 0; x < columns.length; x += 1) {
    const magnitudes = columns[x][channelIndex] || [];
    const drawX = Math.floor(x * columnWidth);
    const drawW = Math.ceil(columnWidth);

    for (let bin = 0; bin < frequencies.length; bin += 1) {
      const current = clamp(frequencies[bin], lowFrequency, highFrequency);
      const previous = clamp(frequencies[Math.max(0, bin - 1)] ?? lowFrequency, lowFrequency, highFrequency);
      const next = clamp(frequencies[Math.min(frequencies.length - 1, bin + 1)] ?? highFrequency, lowFrequency, highFrequency);
      const low = bin === 0 ? lowFrequency : (previous + current) / 2;
      const high = bin === frequencies.length - 1 ? highFrequency : (current + next) / 2;
      const y = yStart + channelHeight - Math.ceil(((high - lowFrequency) / frequencySpan) * channelHeight);
      const nextY = yStart + channelHeight - Math.ceil(((low - lowFrequency) / frequencySpan) * channelHeight);
      const color = colorForDb(magnitudes[bin] ?? dbScaleStart);
      if (color === null) {
        continue;
      }
      const [r, g, b] = color;
      stftCtx.fillStyle = `rgb(${r},${g},${b})`;
      stftCtx.fillRect(drawX, y, drawW, Math.max(1, nextY - y));
    }
  }

  if ((stftPayload.channels || 1) > 1) {
    stftCtx.fillStyle = "rgba(241, 243, 238, 0.75)";
    stftCtx.font = `${Math.max(11, Math.floor(stftCanvas.height * 0.018))}px system-ui`;
    stftCtx.fillText(channelIndex === 0 ? "L" : "R", 12, yStart + 22);
  }
}

function drawStft() {
  resizeCanvas();
  const width = stftCanvas.width;
  const height = stftCanvas.height;

  stftCtx.fillStyle = "#090b0c";
  stftCtx.fillRect(0, 0, width, height);

  const columns = stftPayload?.magnitudesDb || [];
  if (columns.length === 0 || (stftPayload?.frequencies || []).length === 0) {
    stftCtx.fillStyle = "#bac3be";
    stftCtx.font = `${Math.max(14, Math.floor(height * 0.035))}px system-ui`;
    stftCtx.fillText(stftStatusEl.textContent || "録音履歴を選択してください", 22, 44);
    return;
  }

  const channels = stftPayload.channels || 1;
  const channelHeight = Math.floor(height / channels);
  for (let channel = 0; channel < channels; channel += 1) {
    drawChannel(columns, channel, channel * channelHeight, channelHeight);
  }

  if (channels > 1) {
    stftCtx.strokeStyle = "rgba(241, 243, 238, 0.32)";
    stftCtx.lineWidth = Math.max(1, window.devicePixelRatio || 1);
    stftCtx.beginPath();
    stftCtx.moveTo(0, channelHeight);
    stftCtx.lineTo(width, channelHeight);
    stftCtx.stroke();
  }
}

function canvasToBlob(canvas, type = "image/png") {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("画像を作成できませんでした"));
    }, type);
  });
}

function encodeWav(recording) {
  const pcm = new Float32Array(recording.pcm);
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  function writeString(offset, text) {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, recording.channels, true);
  view.setUint32(24, recording.sampleRate, true);
  view.setUint32(28, recording.sampleRate * recording.channels * 2, true);
  view.setUint16(32, recording.channels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function downloadStftImage() {
  if (!stftPayload) {
    return;
  }
  const blob = await canvasToBlob(stftCanvas);
  downloadBlob(blob, `${selectedRecording.id}_stft.png`);
  setStatus("PNGを保存しました");
}

function downloadSelectedWav() {
  if (!selectedRecording) {
    return;
  }
  downloadBlob(encodeWav(selectedRecording), `${selectedRecording.id}.wav`);
}

async function refresh() {
  try {
    await loadRecordings();
    await loadSelectedStft();
  } catch (error) {
    setStatus(`読み込みエラー: ${error.message}`);
    setExportEnabled(false);
  }
}

window.addEventListener("resize", () => {
  resizeCanvas();
  drawStft();
});
refreshButtonEl.addEventListener("click", refresh);
downloadImageButtonEl.addEventListener("click", downloadStftImage);
downloadWavButtonEl.addEventListener("click", downloadSelectedWav);
dbStartInputEl.addEventListener("input", updateDbRange);
dbEndInputEl.addEventListener("input", updateDbRange);
stftWindowInputEl.addEventListener("change", loadSelectedStft);
stftHopInputEl.addEventListener("change", loadSelectedStft);
stftMinFrequencyInputEl.addEventListener("change", loadSelectedStft);
stftMaxFrequencyInputEl.addEventListener("change", loadSelectedStft);

resizeCanvas();
syncDbRangeControls();
drawStft();
setExportEnabled(false);
refresh();
