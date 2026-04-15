const stftCanvas = document.getElementById("stftCanvas");
const stftCtx = stftCanvas.getContext("2d", { alpha: false });
const stftStatusEl = document.getElementById("stftStatus");
const recordingItemsEl = document.getElementById("recordingItems");
const stftWindowInputEl = document.getElementById("stftWindowInput");
const stftHopInputEl = document.getElementById("stftHopInput");
const stftMinFrequencyInputEl = document.getElementById("stftMinFrequencyInput");
const stftMaxFrequencyInputEl = document.getElementById("stftMaxFrequencyInput");
const velocityCountInputEl = document.getElementById("velocityCountInput");
const stftFreqHighEl = document.getElementById("stftFreqHigh");
const stftFreqMidEl = document.getElementById("stftFreqMid");
const stftFreqLowEl = document.getElementById("stftFreqLow");
const dbStartInputEl = document.getElementById("dbStartInput");
const dbEndInputEl = document.getElementById("dbEndInput");
const dbStartValueEl = document.getElementById("dbStartValue");
const dbEndValueEl = document.getElementById("dbEndValue");
const legendDbStartEl = document.getElementById("legendDbStart");
const legendDbEndEl = document.getElementById("legendDbEnd");
const viewTabEls = Array.from(document.querySelectorAll(".viewTab"));
const imageIconSvg = `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm0 15.5-4.7-5.6a1 1 0 0 0-1.5 0l-2.1 2.5-1.2-1.4a1 1 0 0 0-1.5 0L5 17.5V5h14v13.5ZM8.5 10A1.5 1.5 0 1 0 8.5 7a1.5 1.5 0 0 0 0 3Z" /></svg>`;
const wavIconSvg = `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3a1 1 0 0 1 1 1v9.6l2.8-2.8a1 1 0 1 1 1.4 1.4l-4.5 4.5a1 1 0 0 1-1.4 0l-4.5-4.5a1 1 0 1 1 1.4-1.4l2.8 2.8V4a1 1 0 0 1 1-1ZM5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z" /></svg>`;

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
let activeView = "magnitude";

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

function colorForPhase(phase, value = 1) {
  const hue = ((((phase + Math.PI) / (2 * Math.PI)) % 1) + 1) % 1;
  const sector = hue * 6;
  const c = clamp(value, 0, 1);
  const x = c * (1 - Math.abs((sector % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;

  if (sector < 1) {
    r = c;
    g = x;
  } else if (sector < 2) {
    r = x;
    g = c;
  } else if (sector < 3) {
    g = c;
    b = x;
  } else if (sector < 4) {
    g = x;
    b = c;
  } else if (sector < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  const floor = 18;
  const scale = 237;
  return [
    Math.round(floor + r * scale),
    Math.round(floor + g * scale),
    Math.round(floor + b * scale),
  ];
}

function valueForDb(db) {
  return clamp((db - dbStart) / Math.max(1, dbEnd - dbStart), 0, 1);
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

function setActiveView(view) {
  activeView = view;
  for (const tab of viewTabEls) {
    const selected = tab.dataset.view === view;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", selected ? "true" : "false");
  }
  drawStft();
}

function setStatus(message) {
  stftStatusEl.textContent = message;
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

function setExportEnabled() {
  const disabled = recordings.length === 0;
  for (const button of recordingItemsEl.querySelectorAll(".recordingDownloadButton")) {
    button.disabled = disabled;
  }
}

function createRecordingDownloadButton(label, iconSvg, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "recordingDownloadButton";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = iconSvg;
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await onClick();
    } catch (error) {
      setStatus(`保存エラー: ${error.message}`);
    }
  });
  return button;
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

    const downloadActions = document.createElement("div");
    downloadActions.className = "recordingDownloadActions";
    downloadActions.append(
      createRecordingDownloadButton("この録音の画像PNGを保存", imageIconSvg, () =>
        downloadRecordingImage(recording.id)
      ),
      createRecordingDownloadButton("この録音のWAVを保存", wavIconSvg, () =>
        downloadRecordingWav(recording.id)
      )
    );

    const itemTop = document.createElement("div");
    itemTop.className = "recordingItemTop";

    selectButton.append(title, meta, device);
    selectButton.addEventListener("click", () => selectRecording(recording.id));
    memoLabel.append(memoTitle, memoInput);
    itemTop.append(selectButton, downloadActions);
    item.append(itemTop, memoLabel);
    recordingItemsEl.appendChild(item);
  }

  setExportEnabled();
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

function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0;
}

function dftBins(input, bins) {
  const real = new Float32Array(bins.length);
  const imag = new Float32Array(bins.length);

  for (let binIndex = 0; binIndex < bins.length; binIndex += 1) {
    const bin = bins[binIndex];
    const angleStep = (-2 * Math.PI * bin) / input.length;
    let sumReal = 0;
    let sumImag = 0;
    for (let i = 0; i < input.length; i += 1) {
      const angle = angleStep * i;
      sumReal += input[i] * Math.cos(angle);
      sumImag += input[i] * Math.sin(angle);
    }
    real[binIndex] = sumReal;
    imag[binIndex] = sumImag;
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
  const windowSize = sanitizedInput(stftWindowInputEl, 2048, 128, 32768);
  const hopSize = Math.max(32, Math.round(numericInput(stftHopInputEl, 512)));
  const { minFrequency, maxFrequency } = selectedFrequencyRange();
  const pcm = new Float32Array(recording.pcm);

  if (recording.frames < windowSize) {
    throw new Error("録音がwindowより短いです");
  }

  const nyquist = recording.sampleRate / 2;
  const high = Math.min(maxFrequency, nyquist);
  const binCount = Math.floor(windowSize / 2) + 1;
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
    const channelPhases = [];
    for (let channel = 0; channel < recording.channels; channel += 1) {
      const frame = channelFrame(pcm, start, channel, recording.channels, window);
      const spectrum = isPowerOfTwo(windowSize) ? fftReal(frame) : dftBins(frame, frequencyBins);
      const magnitudes = new Array(frequencies.length);
      const phases = new Array(frequencies.length);
      for (let index = 0; index < frequencyBins.length; index += 1) {
        const bin = isPowerOfTwo(windowSize) ? frequencyBins[index] : index;
        const magnitude =
          Math.hypot(spectrum.real[bin], spectrum.imag[bin]) / (windowSize / 2);
        magnitudes[index] = 20 * Math.log10(Math.max(magnitude, 1.0e-10));
        phases[index] = Math.atan2(spectrum.imag[bin], spectrum.real[bin]);
      }
      channelColumns.push(magnitudes);
      channelPhases.push(phases);
    }
    return { channelColumns, channelPhases };
  });

  return {
    recording,
    windowSize,
    hopSize,
    channels: recording.channels,
    frequencies,
    times: starts.map((start) => start / recording.sampleRate),
    magnitudesDb: columns.map((column) => column.channelColumns),
    phases: columns.map((column) => column.channelPhases),
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

function binRect(bin, yStart, channelHeight) {
  const frequencies = stftPayload.frequencies || [];
  const lowFrequency = frequencies[0] || 0;
  const highFrequency = frequencies[frequencies.length - 1] || 1;
  const frequencySpan = Math.max(1, highFrequency - lowFrequency);
  const current = clamp(frequencies[bin], lowFrequency, highFrequency);
  const previous = clamp(frequencies[Math.max(0, bin - 1)] ?? lowFrequency, lowFrequency, highFrequency);
  const next = clamp(frequencies[Math.min(frequencies.length - 1, bin + 1)] ?? highFrequency, lowFrequency, highFrequency);
  const low = bin === 0 ? lowFrequency : (previous + current) / 2;
  const high = bin === frequencies.length - 1 ? highFrequency : (current + next) / 2;
  const y = yStart + channelHeight - Math.ceil(((high - lowFrequency) / frequencySpan) * channelHeight);
  const nextY = yStart + channelHeight - Math.ceil(((low - lowFrequency) / frequencySpan) * channelHeight);
  return { y, height: Math.max(1, nextY - y) };
}

function yForFrequency(frequency, yStart, channelHeight) {
  const frequencies = stftPayload.frequencies || [];
  const lowFrequency = frequencies[0] || 0;
  const highFrequency = frequencies[frequencies.length - 1] || 1;
  const frequencySpan = Math.max(1, highFrequency - lowFrequency);
  return yStart + channelHeight - ((clamp(frequency, lowFrequency, highFrequency) - lowFrequency) / frequencySpan) * channelHeight;
}

function drawChannelLabel(channelIndex, yStart) {
  if ((stftPayload.channels || 1) <= 1) {
    return;
  }
  stftCtx.fillStyle = "rgba(241, 243, 238, 0.75)";
  stftCtx.font = `${Math.max(11, Math.floor(stftCanvas.height * 0.018))}px system-ui`;
  stftCtx.fillText(channelIndex === 0 ? "L" : "R", 12, yStart + 22);
}

function drawMagnitudeChannel(columns, channelIndex, yStart, channelHeight, opacity = 1) {
  const width = stftCanvas.width;
  const frequencies = stftPayload.frequencies || [];
  const columnWidth = Math.max(1, width / Math.max(1, columns.length));

  for (let x = 0; x < columns.length; x += 1) {
    const magnitudes = columns[x][channelIndex] || [];
    const drawX = Math.floor(x * columnWidth);
    const drawW = Math.ceil(columnWidth);

    for (let bin = 0; bin < frequencies.length; bin += 1) {
      const color = colorForDb(magnitudes[bin] ?? dbScaleStart);
      if (color === null) {
        continue;
      }
      const [r, g, b] = color;
      const rect = binRect(bin, yStart, channelHeight);
      stftCtx.fillStyle = `rgba(${r},${g},${b},${opacity})`;
      stftCtx.fillRect(drawX, rect.y, drawW, rect.height);
    }
  }

  drawChannelLabel(channelIndex, yStart);
}

function drawPhaseChannel(phaseColumns, magnitudeColumns, channelIndex, yStart, channelHeight, useAmplitude) {
  const width = stftCanvas.width;
  const frequencies = stftPayload.frequencies || [];
  const columnWidth = Math.max(1, width / Math.max(1, phaseColumns.length));

  for (let x = 0; x < phaseColumns.length; x += 1) {
    const phases = phaseColumns[x][channelIndex] || [];
    const magnitudes = magnitudeColumns[x]?.[channelIndex] || [];
    const drawX = Math.floor(x * columnWidth);
    const drawW = Math.ceil(columnWidth);

    for (let bin = 0; bin < frequencies.length; bin += 1) {
      const value = useAmplitude ? 0.18 + valueForDb(magnitudes[bin] ?? dbScaleStart) * 0.82 : 0.92;
      if (useAmplitude && value <= 0.18) {
        continue;
      }
      const [r, g, b] = colorForPhase(phases[bin] ?? 0, value);
      const rect = binRect(bin, yStart, channelHeight);
      stftCtx.fillStyle = `rgb(${r},${g},${b})`;
      stftCtx.fillRect(drawX, rect.y, drawW, rect.height);
    }
  }

  drawChannelLabel(channelIndex, yStart);
}

function ridgePointsForChannel(columns, channelIndex, yStart, channelHeight) {
  const width = stftCanvas.width;
  const frequencies = stftPayload.frequencies || [];
  const columnWidth = Math.max(1, width / Math.max(1, columns.length));
  const points = [];

  for (let x = 0; x < columns.length; x += 1) {
    const magnitudes = columns[x][channelIndex] || [];
    let bestBin = 0;
    let bestDb = -Infinity;
    for (let bin = 0; bin < frequencies.length; bin += 1) {
      const db = magnitudes[bin] ?? -Infinity;
      if (db > bestDb) {
        bestDb = db;
        bestBin = bin;
      }
    }
    points.push({
      x: x * columnWidth + columnWidth / 2,
      y: yForFrequency(frequencies[bestBin] || 0, yStart, channelHeight),
      frequency: frequencies[bestBin] || 0,
      db: bestDb,
    });
  }

  return points;
}

function drawPolyline(points, color, width) {
  if (points.length < 2) {
    return;
  }
  stftCtx.strokeStyle = color;
  stftCtx.lineWidth = width;
  stftCtx.beginPath();
  stftCtx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) {
    stftCtx.lineTo(point.x, point.y);
  }
  stftCtx.stroke();
}

function derivativeSeriesForRidge(ridge, times, order) {
  let samples = ridge.map((point, index) => ({
    x: point.x,
    time: Number(times[index] ?? index),
    value: point.frequency,
  }));

  for (let derivative = 0; derivative < order; derivative += 1) {
    const nextSamples = [];
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1];
      const current = samples[index];
      const dt = current.time - previous.time;
      if (!Number.isFinite(dt) || dt <= 0) {
        continue;
      }
      nextSamples.push({
        x: (previous.x + current.x) / 2,
        time: (previous.time + current.time) / 2,
        value: (current.value - previous.value) / dt,
      });
    }
    samples = nextSamples;
    if (samples.length < 2) {
      break;
    }
  }

  return samples.filter((sample) => Number.isFinite(sample.value));
}

function formatDerivativeValue(value) {
  const absValue = Math.abs(value);
  if (absValue > 0 && (absValue < 0.01 || absValue >= 10000)) {
    return value.toExponential(2);
  }
  if (absValue >= 1000) {
    return value.toFixed(0);
  }
  if (absValue >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

function derivativeUnits(order) {
  return order === 1 ? "Hz/s" : `Hz/s^${order}`;
}

function derivativeLabel(order) {
  return order === 1 ? "df/dt" : `d^${order}f/dt^${order}`;
}

function drawDerivativeGraph(samples, order, yStart, channelHeight) {
  if (samples.length < 2) {
    return;
  }

  const values = samples.map((sample) => sample.value);
  const maxAbs = Math.max(...values.map((value) => Math.abs(value)));
  if (!Number.isFinite(maxAbs) || maxAbs <= 0) {
    return;
  }

  const centerY = yStart + channelHeight * 0.5;
  const graphHalfHeight = channelHeight * 0.36;
  const scale = graphHalfHeight / maxAbs;
  const graphPoints = samples.map((sample) => ({
    x: sample.x,
    y: centerY - sample.value * scale,
  }));

  stftCtx.strokeStyle = "rgba(241, 243, 238, 0.34)";
  stftCtx.lineWidth = Math.max(1, window.devicePixelRatio || 1);
  stftCtx.beginPath();
  stftCtx.moveTo(0, centerY);
  stftCtx.lineTo(stftCanvas.width, centerY);
  stftCtx.stroke();

  drawPolyline(graphPoints, "rgba(75, 201, 196, 0.96)", Math.max(1.5, (window.devicePixelRatio || 1) * 1.5));

  const maxValue = Math.max(...values);
  const minValue = Math.min(...values);
  stftCtx.fillStyle = "rgba(241, 243, 238, 0.82)";
  stftCtx.font = `${Math.max(11, Math.floor(stftCanvas.height * 0.015))}px system-ui`;
  stftCtx.textBaseline = "top";
  stftCtx.fillText(derivativeLabel(order), 12, yStart + 10);
  stftCtx.fillText(`+${formatDerivativeValue(maxValue)} ${derivativeUnits(order)}`, 12, yStart + 28);
  stftCtx.textBaseline = "bottom";
  stftCtx.fillText(`${formatDerivativeValue(minValue)} ${derivativeUnits(order)}`, 12, yStart + channelHeight - 10);
}

function drawCollapseVelocityChannel(columns, channelIndex, yStart, channelHeight) {
  const ridge = ridgePointsForChannel(columns, channelIndex, yStart, channelHeight);
  const lineWidth = Math.max(1.5, (window.devicePixelRatio || 1) * 1.5);
  const derivativeOrder = Math.round(clamp(numericInput(velocityCountInputEl, 1), 1, 24));
  velocityCountInputEl.value = String(derivativeOrder);

  drawMagnitudeChannel(columns, channelIndex, yStart, channelHeight, 0.28);
  drawDerivativeGraph(derivativeSeriesForRidge(ridge, stftPayload.times || [], derivativeOrder), derivativeOrder, yStart, channelHeight);
  drawPolyline(ridge, "rgba(244, 91, 68, 0.96)", lineWidth);
  drawChannelLabel(channelIndex, yStart);
}

function drawStft() {
  resizeCanvas();
  const width = stftCanvas.width;
  const height = stftCanvas.height;

  stftCtx.fillStyle = "#090b0c";
  stftCtx.fillRect(0, 0, width, height);

  const columns = stftPayload?.magnitudesDb || [];
  const phases = stftPayload?.phases || [];
  if (columns.length === 0 || (stftPayload?.frequencies || []).length === 0) {
    stftCtx.fillStyle = "#bac3be";
    stftCtx.font = `${Math.max(14, Math.floor(height * 0.035))}px system-ui`;
    stftCtx.fillText(stftStatusEl.textContent || "録音履歴を選択してください", 22, 44);
    return;
  }

  const channels = stftPayload.channels || 1;
  const channelHeight = Math.floor(height / channels);
  for (let channel = 0; channel < channels; channel += 1) {
    const yStart = channel * channelHeight;
    if (activeView === "phase") {
      drawPhaseChannel(phases, columns, channel, yStart, channelHeight, false);
    } else if (activeView === "phaseAmplitude") {
      drawPhaseChannel(phases, columns, channel, yStart, channelHeight, true);
    } else if (activeView === "collapseVelocity") {
      drawCollapseVelocityChannel(columns, channel, yStart, channelHeight);
    } else {
      drawMagnitudeChannel(columns, channel, yStart, channelHeight);
    }
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

async function downloadRecordingImage(recordingId) {
  if (!recordingId) {
    return;
  }
  if (selectedRecordingId !== recordingId || stftPayload?.recording?.id !== recordingId) {
    await selectRecording(recordingId);
  }
  const blob = await canvasToBlob(stftCanvas);
  downloadBlob(blob, `${recordingId}_stft.png`);
  setStatus("PNGを保存しました");
}

function downloadRecordingWav(recordingId) {
  const recording = recordings.find((item) => item.id === recordingId);
  if (!recording) {
    return;
  }
  downloadBlob(encodeWav(recording), `${recording.id}.wav`);
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
dbStartInputEl.addEventListener("input", updateDbRange);
dbEndInputEl.addEventListener("input", updateDbRange);
velocityCountInputEl.addEventListener("input", drawStft);
for (const tab of viewTabEls) {
  tab.addEventListener("click", () => setActiveView(tab.dataset.view || "magnitude"));
}
stftWindowInputEl.addEventListener("change", loadSelectedStft);
stftHopInputEl.addEventListener("change", loadSelectedStft);
stftMinFrequencyInputEl.addEventListener("change", loadSelectedStft);
stftMaxFrequencyInputEl.addEventListener("change", loadSelectedStft);

resizeCanvas();
syncDbRangeControls();
drawStft();
setExportEnabled(false);
refresh();
