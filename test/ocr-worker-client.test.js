import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { OcrWorkerClient } from '../src/phase2/ocr/index.js';
import { BoundedOcrTextLog } from '../src/phase2/ocr/text-log.js';

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.terminated = false;
  }

  postMessage(message) {
    this.messages.push(message);
  }

  async terminate() {
    if (this.terminated) return 0;
    this.terminated = true;
    this.emit('exit', 0);
    return 0;
  }

  ready() {
    this.emit('message', { type: 'READY' });
  }

  result(requestId, result) {
    this.emit('message', { type: 'RESULT', requestId, result });
  }
}

const turn = () => new Promise(resolve => setImmediate(resolve));
const recognitionMessages = worker => worker.messages.filter(message => message.type === 'RECOGNIZE');

async function readyClient() {
  const worker = new FakeWorker();
  let creations = 0;
  const client = new OcrWorkerClient({
    workerFactory: () => { creations += 1; return worker; },
    modelsPath: '/models',
  });
  const first = client.init();
  const second = client.init();
  assert.equal(first, second, 'initialization must be single-flight');
  assert.equal(creations, 1);
  assert.deepEqual(worker.messages, [{ type: 'INIT', modelsPath: '/models', debugImagePath: null }]);
  worker.ready();
  await Promise.all([first, second]);
  return { client, worker };
}

test('OCR queue executes one frame and retains only the newest pending frame', async () => {
  const { client, worker } = await readyClient();
  const generation = client.startSession();
  const first = client.recognize(Buffer.from('first'), { generation });
  const replaced = client.recognize(Buffer.from('replaced'), { generation });
  const newest = client.recognize(Buffer.from('newest'), { generation });
  await turn();

  assert.equal(recognitionMessages(worker).length, 1);
  assert.equal(recognitionMessages(worker)[0].image.toString(), 'first');
  assert.equal(await replaced, null);

  const firstId = recognitionMessages(worker)[0].requestId;
  worker.result(firstId, { text: 'one' });
  assert.equal((await first).text, 'one');
  await turn();

  assert.equal(recognitionMessages(worker).length, 2);
  assert.equal(recognitionMessages(worker)[1].image.toString(), 'newest');
  const newestId = recognitionMessages(worker)[1].requestId;
  worker.result(newestId, { text: 'three' });
  assert.equal((await newest).text, 'three');
  await client.shutdown();
});

test('stopped-session results are stale and restart waits behind the old native call', async () => {
  const { client, worker } = await readyClient();
  const oldGeneration = client.startSession();
  const oldActive = client.recognize(Buffer.from('old-active'), { generation: oldGeneration });
  const oldPending = client.recognize(Buffer.from('old-pending'), { generation: oldGeneration });
  await turn();
  const oldId = recognitionMessages(worker)[0].requestId;

  client.stopSession();
  assert.equal(await oldPending, null);
  const newGeneration = client.startSession();
  const current = client.recognize(Buffer.from('current'), { generation: newGeneration });
  await turn();
  assert.equal(recognitionMessages(worker).length, 1, 'old inference remains the sole in-flight worker call');

  worker.result(oldId, { text: 'must-not-escape' });
  assert.equal(await oldActive, null);
  await turn();
  assert.equal(recognitionMessages(worker).length, 2);
  assert.equal(recognitionMessages(worker)[1].image.toString(), 'current');

  worker.result(recognitionMessages(worker)[1].requestId, { text: 'current-result' });
  assert.equal((await current).text, 'current-result');
  await client.shutdown();
});

test('paused OCR performs no new inference and resumes only its latest screenshot', async () => {
  const { client, worker } = await readyClient();
  const generation = client.startSession();
  client.setPaused(true);
  const oldPending = client.recognize(Buffer.from('while-speaking-1'), { generation });
  const latest = client.recognize(Buffer.from('while-speaking-2'), { generation });
  await turn();
  assert.equal(await oldPending, null);
  assert.equal(recognitionMessages(worker).length, 0);

  client.setPaused(false);
  assert.equal(recognitionMessages(worker).length, 1);
  assert.equal(recognitionMessages(worker)[0].image.toString(), 'while-speaking-2');
  worker.result(recognitionMessages(worker)[0].requestId, { text: 'latest' });
  assert.equal((await latest).text, 'latest');
  await client.shutdown();
});

test('worker failure is fatal and rejects active and pending work once', async () => {
  const { client, worker } = await readyClient();
  const generation = client.startSession();
  const active = client.recognize(Buffer.from('active'), { generation });
  const pending = client.recognize(Buffer.from('pending'), { generation });
  await turn();
  const activeRejected = assert.rejects(active, error => error.ocrFatal === true && /native crash/.test(error.message));
  const pendingRejected = assert.rejects(pending, error => error.ocrFatal === true && /native crash/.test(error.message));
  worker.emit('error', new Error('native crash'));
  await Promise.all([activeRejected, pendingRejected]);
  await assert.rejects(client.init(), error => error.ocrFatal === true);
  await client.shutdown();
});

test('shutdown settles pending initialization and is terminal and idempotent', async () => {
  const worker = new FakeWorker();
  const client = new OcrWorkerClient({ workerFactory: () => worker });
  const initializing = client.init();
  const rejected = assert.rejects(initializing, /shut down during initialization/);
  await client.shutdown();
  await rejected;
  await client.shutdown();
  await assert.rejects(client.init(), /has been shut down/);
  client.startSession();
  assert.equal(await client.recognize(Buffer.from('ignored')), null);
});

test('synchronous worker construction failure rejects the original init promise', async () => {
  const client = new OcrWorkerClient({
    workerFactory: () => { throw new Error('cannot construct worker'); },
  });
  await assert.rejects(client.init(), error => error.ocrFatal === true && /cannot construct/.test(error.message));
});

test('rejected barrage start leaves STOP as the final backend event', async () => {
  const source = await readFile(new URL('../src/ui-bridge.js', import.meta.url), 'utf8');
  let server;
  class FakeServer extends EventEmitter {
    constructor() { super(); this.clients = new Set(); server = this; }
  }
  const context = vm.createContext({
    WebSocketServer: FakeServer,
    Buffer,
    console: { log() {}, warn() {}, error() {} },
    process: { env: {} },
    writeSync() {},
  });
  const script = source.replace(/\r\n?/g, '\n').replace(/^import .+\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(script + '\nthis.bridge = { start, on, broadcast };', context);
  context.bridge.start(0);
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.messages = [];
  socket.send = raw => socket.messages.push(JSON.parse(raw));
  server.clients.add(socket);
  server.emit('connection', socket);
  socket.messages.length = 0;

  context.bridge.on('onBarrageStart', () => {
    context.bridge.broadcast('BARRAGE_STOP', {});
    return false;
  });
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'BARRAGE_START', data: { width: 10 } })), false);
  assert.deepEqual(socket.messages.map(message => message.type), ['BARRAGE_STOP']);
});

test('renderer capture waits for backend START and owns generation cleanup', async () => {
  const liveMonitor = await readFile(
    new URL('../robot-ui/src/renderer/src/components/LiveMonitor.vue', import.meta.url),
    'utf8',
  );
  const selectionStart = liveMonitor.indexOf('onBarrageRegionSelected((rect) =>');
  const selectionEnd = liveMonitor.indexOf('let currentSocket', selectionStart);
  const selectionHandler = liveMonitor.slice(selectionStart, selectionEnd);
  assert.ok(selectionStart >= 0 && selectionEnd > selectionStart);
  assert.doesNotMatch(selectionHandler, /send\('BARRAGE_START', rect\)[\s\S]{0,100}startBarrageLoop/);
  assert.match(liveMonitor, /case 'BARRAGE_START':[\s\S]*startBarrageLoop\(\)/);
  assert.match(liveMonitor, /const generation = \+\+barrageCaptureGeneration/);
  assert.match(liveMonitor, /generation !== barrageCaptureGeneration/);
  assert.match(liveMonitor, /maxFrameRate: BARRAGE_CAPTURE_MAX_FPS/);
  assert.match(liveMonitor, /captureTrack\?\.applyConstraints/);
  assert.match(liveMonitor, /captureTrack\?\.getSettings/);
  assert.match(liveMonitor, /encodeInFlight/);
  assert.match(liveMonitor, /BARRAGE_SOCKET_BACKLOG_LIMIT/);
  assert.match(liveMonitor, /videoEl\.videoWidth \/ captureDisplay\.width/);
  assert.match(liveMonitor, /onUnmounted\([\s\S]*stopBarrageLoop\(\)/);

  const controls = await readFile(
    new URL('../robot-ui/src/renderer/src/components/Controls.vue', import.meta.url),
    'utf8',
  );
  const controlsSelectionStart = controls.indexOf('onBarrageRegionSelected((rect) =>');
  const controlsSelectionEnd = controls.indexOf('onUnmounted(', controlsSelectionStart);
  const controlsSelectionHandler = controls.slice(controlsSelectionStart, controlsSelectionEnd);
  assert.ok(controlsSelectionStart >= 0 && controlsSelectionEnd > controlsSelectionStart);
  assert.match(controls, /case 'BARRAGE_STOP':[\s\S]*barrageEnabled\.value = false/);
  assert.match(controls, /弹幕区域已选中，正在启动识别…/);
  assert.match(controls, /const ocrStatusMsg = computed\([\s\S]*正在启动[\s\S]*识别中[\s\S]*请选择识别区域/);
  assert.doesNotMatch(controls, /case 'BARRAGE_START':[\s\S]{0,180}ElMessage\.success/);
  assert.match(controls, /case 'ERROR':[\s\S]*\/OCR\|弹幕识别\//);
  assert.doesNotMatch(controlsSelectionHandler, /ElMessage\.success/);
  assert.match(liveMonitor, /const sourceResult = await window\.api\.getScreenSourceId\(\)/);
  assert.match(liveMonitor, /sourceResult\?\.canOpenSettings/);
  assert.match(liveMonitor, /Hot stream ready[\s\S]{0,180}ElMessage\.success\('弹幕识别已启动'\)/);
  assert.match(
    liveMonitor,
    /if \(!window\.api\?\.getScreenSourceId\)[\s\S]{0,260}return[\s\S]{0,120}const generation = \+\+barrageCaptureGeneration/,
  );
  assert.match(controls, /const canCaptureBarrage = Boolean\([\s\S]*openBarrageOverlay[\s\S]*getScreenSourceId[\s\S]*onBarrageRegionSelected/);
  assert.match(controls, /:disabled="!canCaptureBarrage"/);
  assert.match(controls, /if \(!canCaptureBarrage\)[\s\S]{0,420}return/);
  assert.match(
    controls,
    /function onSocketOpen\(\)[\s\S]*ownsBarrageCapture\.value[\s\S]*send\('BARRAGE_START', barrageRegion\.value\)/,
  );
  assert.match(liveMonitor, /onMounted\(async \(\) => \{[\s\S]{0,220}onBarrageRegionSelected/);
  assert.match(liveMonitor, /if \(ownsBarrageCapture\) startBarrageLoop\(\)/);

  const main = await readFile(
    new URL('../robot-ui/src/main/machine-runtime.js', import.meta.url),
    'utf8',
  );
  const closeHandlerStart = main.indexOf("ipcMain.handle('close-barrage-overlay'");
  const closeHandlerEnd = main.indexOf('// ─── IPC: File picker', closeHandlerStart);
  const closeHandler = main.slice(closeHandlerStart, closeHandlerEnd);
  assert.match(closeHandler, /finishSelection\?\.\(rect \|\| null\)/);
  assert.doesNotMatch(closeHandler, /if \(rect &&/);
});

test('production worker source keeps native concurrency bounded', async () => {
  const source = await readFile(new URL('../src/phase2/ocr/worker.js', import.meta.url), 'utf8');
  assert.match(source, /sharp\.concurrency\(1\)/);
  assert.match(source, /intraOpNumThreads: 2/);
  assert.match(source, /interOpNumThreads: 1/);
  assert.match(source, /executionMode: 'sequential'/);
  assert.doesNotMatch(source, /Promise\.all\(.*box/s);
  assert.doesNotMatch(source, /sharp\(imageBuffer\)[\s\S]{0,100}\.extract\(/);

  const preprocess = await readFile(new URL('../src/phase2/ocr/preprocess.js', import.meta.url), 'utf8');
  assert.match(preprocess, /sourceData/);
  assert.match(preprocess, /sharp\(sourceData, \{/);
});

test('OCR runtime stays pinned to the last package carrying both macOS Intel and Windows x64 bindings', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dependencies['onnxruntime-node'], '1.23.2');
  assert.equal(manifest.overrides['adm-zip'], '0.6.0');
  assert.equal(lock.packages[''].dependencies['onnxruntime-node'], '1.23.2');
  assert.equal(lock.packages['node_modules/onnxruntime-node'].version, '1.23.2');
  assert.equal(lock.packages['node_modules/adm-zip'].version, '0.6.0');
});

test('OCR text log preserves reset ordering and newest-session plain text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ocr-text-log-'));
  const filePath = join(directory, 'barrage-ocr-log.txt');
  try {
    const log = new BoundedOcrTextLog({ filePath });
    log.reset();
    log.append('old session\n');
    log.reset();
    log.append('new first\n');
    log.append('new second\n');
    await log.flush();
    assert.equal(await readFile(filePath, 'utf8'), 'new first\nnew second\n');
    await log.close();
    assert.equal(log.append('after close\n'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('slow OCR text log drops excess records instead of growing its queue', async () => {
  let releaseMkdir;
  const writes = [];
  const fsApi = {
    mkdir: () => new Promise(resolve => { releaseMkdir = resolve; }),
    writeFile: async (...args) => { writes.push(['write', ...args]); },
    appendFile: async (...args) => { writes.push(['append', ...args]); },
  };
  const warnings = [];
  const log = new BoundedOcrTextLog({
    filePath: '/virtual/barrage.txt',
    maxPending: 2,
    fsApi,
    logger: { warn: message => warnings.push(message), error() {} },
  });
  log.reset();
  assert.equal(log.append('kept\n'), true);
  assert.equal(log.append('dropped\n'), false);
  assert.equal(log.dropped, 1);
  assert.equal(warnings.length, 1);
  await turn();
  releaseMkdir();
  await log.flush();
  assert.deepEqual(writes.map(entry => entry[0]), ['write', 'append']);
});
