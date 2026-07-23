import { AudioAnalyzer } from './audio/analyzer';
import { featureStore } from './audio/featureStore';
import { SILENT_FEATURES, SIGNAL_THRESHOLD_DBFS, type RecordingState } from './audio/types';
import { ParticleRenderer } from './render/ParticleRenderer';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div class="shell">
    <header class="top">
      <div class="brand">Axis Field</div>
      <div class="subtitle">线性万花筒声场</div>
    </header>

    <main class="stage">
      <canvas id="gl" aria-label="音频驱动粒子可视化"></canvas>
      <div class="vignette" aria-hidden="true"></div>
    </main>

    <div class="dock">
    <section class="status" aria-live="polite">
      <div class="timer-row">
        <span class="rec-dot" id="recDot" data-active="false"></span>
        <time id="timer" datetime="PT0S">00:00:00</time>
        <span class="state-label" id="stateLabel">就绪</span>
      </div>
      <div class="meters" aria-hidden="true">
        <div class="meter"><span>VOL</span><i id="mVol"></i></div>
        <div class="meter"><span>PITCH</span><i id="mPitch"></i></div>
        <div class="meter"><span>MID</span><i id="mMid"></i></div>
        <div class="meter"><span>TRE</span><i id="mTre"></i></div>
      </div>

      <div
        class="mic-monitor"
        id="micMonitor"
        data-listening="false"
        data-signal="false"
        role="status"
        aria-live="polite"
        aria-label="麦克风音量检测"
      >
        <div class="mic-monitor__head">
          <span class="mic-monitor__title">麦克风检测</span>
          <span class="mic-monitor__badge" id="micBadge">未监听</span>
        </div>
        <label class="mic-monitor__device">
          <span>输入设备</span>
          <select id="micDevice" aria-label="选择麦克风设备">
            <option value="">系统默认</option>
          </select>
        </label>
        <div class="mic-monitor__bar" aria-hidden="true">
          <div class="mic-monitor__fill" id="micFill"></div>
          <div class="mic-monitor__threshold" title="有声阈值"></div>
        </div>
        <div class="mic-monitor__meta">
          <span id="micDb">— dBFS</span>
          <span id="micLevel">音量 0%</span>
        </div>
        <p class="mic-monitor__device-label" id="micDeviceLabel">尚未连接麦克风</p>
      </div>

      <p class="hint" id="hint">授权麦克风后：音调改变主体轮廓（低音宽圆、中音折叠、高音锐利），音量只调亮度与波动；静音时曲线仍缓慢形变。</p>
      <p class="error" id="error" hidden></p>
    </section>

    <footer class="controls">
      <button type="button" class="btn primary" id="btnPrimary" aria-label="开始录音">开始</button>
      <button type="button" class="btn ghost" id="btnStop" aria-label="结束录音" disabled>结束</button>
      <a class="btn ghost download" id="btnDownload" hidden download="recording.webm">下载录音</a>
    </footer>
      </div>

    <aside class="debug" id="debug">
      <span id="fps">— fps</span>
      ·
      <span id="tier">medium</span>
      ·
      <span id="pcount">— pts</span>
    </aside>
  </div>
`;

const canvas = document.querySelector<HTMLCanvasElement>('#gl')!;
const timerEl = document.querySelector<HTMLTimeElement>('#timer')!;
const stateLabel = document.querySelector<HTMLSpanElement>('#stateLabel')!;
const recDot = document.querySelector<HTMLSpanElement>('#recDot')!;
const hintEl = document.querySelector<HTMLParagraphElement>('#hint')!;
const errorEl = document.querySelector<HTMLParagraphElement>('#error')!;
const btnPrimary = document.querySelector<HTMLButtonElement>('#btnPrimary')!;
const btnStop = document.querySelector<HTMLButtonElement>('#btnStop')!;
const btnDownload = document.querySelector<HTMLAnchorElement>('#btnDownload')!;
const mVol = document.querySelector<HTMLElement>('#mVol')!;
const mPitch = document.querySelector<HTMLElement>('#mPitch')!;
const mMid = document.querySelector<HTMLElement>('#mMid')!;
const mTre = document.querySelector<HTMLElement>('#mTre')!;
const micMonitor = document.querySelector<HTMLElement>('#micMonitor')!;
const micBadge = document.querySelector<HTMLSpanElement>('#micBadge')!;
const micFill = document.querySelector<HTMLElement>('#micFill')!;
const micDb = document.querySelector<HTMLSpanElement>('#micDb')!;
const micLevel = document.querySelector<HTMLSpanElement>('#micLevel')!;
const micDevice = document.querySelector<HTMLSelectElement>('#micDevice')!;
const micDeviceLabel = document.querySelector<HTMLParagraphElement>('#micDeviceLabel')!;
const fpsEl = document.querySelector<HTMLSpanElement>('#fps')!;
const tierEl = document.querySelector<HTMLSpanElement>('#tier')!;
const pcountEl = document.querySelector<HTMLSpanElement>('#pcount')!;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const analyzer = new AudioAnalyzer();
let state: RecordingState = 'Idle';
let renderer: ParticleRenderer;
let lastBlobUrl: string | null = null;
let clockTimer: number | null = null;

const STATE_TEXT: Record<RecordingState, string> = {
  Idle: '就绪',
  RequestingPermission: '等待授权',
  Recording: '录音中',
  Paused: '已暂停',
  Saving: '保存中',
  Completed: '已完成',
  Error: '出错',
};

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function setError(message: string | null): void {
  if (!message) {
    errorEl.hidden = true;
    errorEl.textContent = '';
    return;
  }
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function syncUi(): void {
  stateLabel.textContent = STATE_TEXT[state];
  recDot.dataset.active = state === 'Recording' ? 'true' : 'false';

  if (state === 'Idle' || state === 'Completed' || state === 'Error') {
    btnPrimary.textContent = '开始';
    btnPrimary.disabled = false;
    btnPrimary.setAttribute('aria-label', '开始录音');
    btnStop.disabled = true;
  } else if (state === 'RequestingPermission' || state === 'Saving') {
    btnPrimary.disabled = true;
    btnStop.disabled = true;
  } else if (state === 'Recording') {
    btnPrimary.textContent = '暂停';
    btnPrimary.disabled = false;
    btnPrimary.setAttribute('aria-label', '暂停录音');
    btnStop.disabled = false;
  } else if (state === 'Paused') {
    btnPrimary.textContent = '继续';
    btnPrimary.disabled = false;
    btnPrimary.setAttribute('aria-label', '继续录音');
    btnStop.disabled = false;
  }

  renderer.setFrozen(state === 'Paused' || state === 'Completed');

  const listening = state === 'Recording';
  micMonitor.dataset.listening = listening ? 'true' : 'false';
  micDevice.disabled = state === 'Recording' || state === 'Paused' || state === 'Saving';
  if (!listening) {
    micMonitor.dataset.signal = 'false';
    micBadge.textContent =
      state === 'Paused' ? '已暂停' : state === 'RequestingPermission' ? '请求权限' : '未监听';
    if (state !== 'Recording') {
      micFill.style.transform = 'scaleX(0.02)';
      micDb.textContent = '— dBFS';
      micLevel.textContent = '音量 0%';
    }
    if (state === 'Idle' || state === 'Completed' || state === 'Error') {
      micDeviceLabel.textContent = '尚未连接麦克风';
    }
  }
}

async function refreshMicDevices(): Promise<void> {
  try {
    const devices = await analyzer.listInputDevices();
    const current = micDevice.value;
    micDevice.innerHTML = '<option value="">系统默认</option>';
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label;
      micDevice.appendChild(opt);
    }
    if ([...micDevice.options].some((o) => o.value === current)) {
      micDevice.value = current;
    }
  } catch {
    /* ignore enumeration failures before permission */
  }
}

micDevice.addEventListener('change', () => {
  analyzer.setPreferredDevice(micDevice.value || null);
});

function startClock(): void {
  stopClock();
  clockTimer = window.setInterval(() => {
    timerEl.textContent = formatTime(analyzer.elapsedMs());
  }, 200);
}

function stopClock(): void {
  if (clockTimer != null) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
}

async function startRecording(): Promise<void> {
  setError(null);
  btnDownload.hidden = true;
  if (lastBlobUrl) {
    URL.revokeObjectURL(lastBlobUrl);
    lastBlobUrl = null;
  }

  analyzer.setPreferredDevice(micDevice.value || null);
  state = 'RequestingPermission';
  syncUi();
  hintEl.textContent =
    '正在请求麦克风权限…请在浏览器弹窗中选择“允许”。请用 Chrome/Edge 打开 http://127.0.0.1:5173/';

  try {
    await analyzer.start();
    await refreshMicDevices();
    const status = analyzer.getStatus();
    micDeviceLabel.textContent = `已连接：${status.deviceLabel} · AudioContext ${status.contextState}`;
    state = 'Recording';
    syncUi();
    hintEl.textContent =
      '对着麦克风发低音／人声／高音。音调驱动主曲线形状，音量只改变亮度与波动幅度。';
    startClock();
    try {
      navigator.vibrate?.(12);
    } catch {
      /* ignore */
    }
  } catch (err) {
    state = 'Error';
    syncUi();
    const msg = formatMicError(err);
    setError(msg);
    hintEl.textContent = '授权失败后可再次点击开始。也可先在 Windows「设置 → 隐私 → 麦克风」中允许桌面应用访问。';
    micDeviceLabel.textContent = '连接失败';
  }
}

function formatMicError(err: unknown): string {
  if (err instanceof Error && err.message.includes('安全上下文')) return err.message;
  if (err instanceof Error && err.message.includes('getUserMedia')) return err.message;
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      return '麦克风权限被拒绝。请点击地址栏锁图标 → 网站设置 → 麦克风改为“允许”，然后刷新重试。';
    }
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      return '未检测到麦克风设备。请确认系统已接入麦克风，并在下方选择正确输入设备。';
    }
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      return '麦克风被其他应用占用（如腾讯会议/Teams）。请关闭占用后重试。';
    }
    if (err.name === 'OverconstrainedError') {
      return '所选麦克风不支持当前参数，请改选“系统默认”后重试。';
    }
    return `无法启动麦克风：${err.name} ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return '无法启动录音，请检查麦克风权限与设备占用后重试。';
}

function pauseRecording(): void {
  analyzer.pause();
  state = 'Paused';
  syncUi();
  hintEl.textContent = '已暂停。粒子缓慢回落为呼吸态。';
  try {
    navigator.vibrate?.(8);
  } catch {
    /* ignore */
  }
}

function resumeRecording(): void {
  analyzer.resume();
  state = 'Recording';
  syncUi();
  hintEl.textContent = '继续录音中。';
}

async function stopRecording(): Promise<void> {
  state = 'Saving';
  syncUi();
  hintEl.textContent = '正在封装录音…';
  stopClock();

  try {
    const { blob, durationMs } = await analyzer.stop();
    timerEl.textContent = formatTime(durationMs);
    lastBlobUrl = URL.createObjectURL(blob);
    btnDownload.href = lastBlobUrl;
    btnDownload.hidden = false;
    state = 'Completed';
    syncUi();
    hintEl.textContent = `录音完成（${formatTime(durationMs)}）。可下载文件或再次开始。`;
    featureStore.set({ ...SILENT_FEATURES, timestampNanos: performance.now() * 1e6 });
  } catch {
    state = 'Error';
    syncUi();
    setError('保存录音失败，请重试。');
  }
}

btnPrimary.addEventListener('click', () => {
  if (state === 'Idle' || state === 'Completed' || state === 'Error') {
    void startRecording();
  } else if (state === 'Recording') {
    pauseRecording();
  } else if (state === 'Paused') {
    resumeRecording();
  }
});

btnStop.addEventListener('click', () => {
  if (state === 'Recording' || state === 'Paused') {
    void stopRecording();
  }
});

function layout(): void {
  const rect = canvas.parentElement!.getBoundingClientRect();
  renderer.resize(rect.width, rect.height);
}

try {
  renderer = new ParticleRenderer(canvas, 'medium');
  renderer.setReduceMotion(reduceMotion);
  layout();
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  app.innerHTML = `<div class="fatal">渲染初始化失败：${detail}</div>`;
  throw err;
}

window.addEventListener('resize', layout);

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'Recording') {
    pauseRecording();
    hintEl.textContent = '页面进入后台，已自动暂停录音。';
  }
});

function frame(): void {
  const features = featureStore.get();
  renderer.render(features);

  mVol.style.transform = `scaleX(${Math.max(0.02, features.volume)})`;
  mPitch.style.transform = `scaleX(${Math.max(0.02, features.pitchNormalized)})`;
  mMid.style.transform = `scaleX(${Math.max(0.02, features.mid)})`;
  mTre.style.transform = `scaleX(${Math.max(0.02, features.treble)})`;

  const listening = state === 'Recording';
  if (listening) {
    const level = features.instantVolume;
    micFill.style.transform = `scaleX(${Math.max(0.02, level)})`;
    micMonitor.dataset.signal = features.hasSignal ? 'true' : 'false';
    const status = analyzer.getStatus();
    if (status.trackMuted) {
      micBadge.textContent = '设备被静音';
    } else if (status.contextState === 'suspended') {
      micBadge.textContent = '音频引擎暂停';
    } else {
      micBadge.textContent = features.hasSignal ? '检测到声音' : '静音 / 过低';
    }
    micDb.textContent = `${features.dbfs.toFixed(1)} dBFS`;
    micLevel.textContent = `音量 ${Math.round(level * 100)}%`;
    const thresholdPos = (SIGNAL_THRESHOLD_DBFS + 60) / 60;
    micMonitor.style.setProperty('--mic-threshold', String(thresholdPos));
    if (status.error) {
      micDeviceLabel.textContent = status.error;
    }
  }

  fpsEl.textContent = `${renderer.getFps().toFixed(0)} fps`;
  tierEl.textContent = renderer.getQuality();
  pcountEl.textContent = `${renderer.getParticleCount().toLocaleString()} lines`;

  requestAnimationFrame(frame);
}

syncUi();
void refreshMicDevices();
requestAnimationFrame(frame);
