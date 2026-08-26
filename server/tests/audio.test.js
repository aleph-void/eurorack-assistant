import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import {
  connectFakeDevice,
  createTestApp,
  createUser,
  fakeBackend,
  insertModule,
  login,
} from './helpers.js';
import {
  analyzeRecording,
  audioPath,
  audioTextDocument,
  clampRecordDuration,
  parseAudioResult,
  sniffAudioFormat,
} from '../src/services/audio.js';
import { answerQuestion } from '../src/services/ask.js';

// A minimal RIFF/WAVE header followed by a little silence. Nothing decodes
// it; every test that needs real numbers out of it fakes the tool run.
function wavBytes(payload = 64) {
  const data = Buffer.alloc(payload);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + payload, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(96000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(payload, 40);
  return Buffer.concat([header, data]);
}

const WAV_BASE64 = wavBytes().toString('base64');

// Stands in for ffprobe/ffmpeg: answers the two measurement calls with what
// the real tools print, and writes a PNG where the render would.
function fakeAudioTools({ png = true } = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'ffprobe') {
      return {
        code: 0,
        failed: false,
        stderr: '',
        stdout: JSON.stringify({
          format: { duration: '12.5' },
          streams: [{ sample_rate: '48000', channels: 2, codec_name: 'pcm_s16le', duration: '12.5' }],
        }),
      };
    }
    if (args.includes('volumedetect')) {
      return {
        code: 0,
        failed: false,
        stdout: '',
        stderr: '[Parsed_volumedetect_0 @ 0x1] max_volume: -1.5 dB\n[Parsed_volumedetect_0 @ 0x1] mean_volume: -18.25 dB\n',
      };
    }
    // The render: the output path is the last argument.
    if (png) fs.writeFileSync(args[args.length - 1], Buffer.from('89504e470d0a1a0a', 'hex'));
    return { code: png ? 0 : 1, failed: !png, stdout: '', stderr: png ? '' : 'no ffmpeg' };
  };
  run.calls = calls;
  return run;
}

async function fixtureWithModule(options = {}) {
  const fixture = await createTestApp(options);
  fixture.module = await insertModule(fixture.db, (await fixture.db.models.User.findOne({
    where: { username: 'alice' },
  })).id);
  return fixture;
}

const upload = (fixture, body) =>
  request(fixture.app).post('/api/audio').set('Cookie', fixture.aliceCookie).send(body);

describe('sniffAudioFormat', () => {
  it('names a format from the bytes, not from what they are called', () => {
    expect(sniffAudioFormat(wavBytes())).toBe('wav');
    expect(sniffAudioFormat(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)]))).toBe('ogg');
    expect(sniffAudioFormat(Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(20)]))).toBe('flac');
    expect(sniffAudioFormat(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)]))).toBe('mp3');
    expect(
      sniffAudioFormat(Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.alloc(20)]))
    ).toBe('m4a');
    expect(
      sniffAudioFormat(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)]))
    ).toBe('webm');
  });

  it('refuses bytes that are not audio it stores', () => {
    expect(sniffAudioFormat(Buffer.from('%PDF-1.4 and then some more'))).toBeNull();
    expect(sniffAudioFormat(Buffer.alloc(4))).toBeNull();
  });
});

describe('analyzeRecording', () => {
  it('measures the file and stores the drawing of it', async () => {
    const fixture = await createTestApp();
    const bytes = wavBytes();
    const dir = path.join(fixture.capturesDir, 'audio');
    fs.mkdirSync(dir, { recursive: true });
    const hash = 'a'.repeat(64);
    fs.writeFileSync(path.join(dir, `${hash}.wav`), bytes);

    const measured = await analyzeRecording(fixture.capturesDir, hash, 'wav', {
      run: fakeAudioTools(),
    });
    expect(measured.duration_seconds).toBe(12.5);
    expect(measured.sample_rate).toBe(48000);
    expect(measured.channel_count).toBe(2);
    expect(measured.peak_dbfs).toBe(-1.5);
    expect(measured.rms_dbfs).toBe(-18.25);
    expect(measured.waveform_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // An install without ffmpeg still takes recordings; it just has nothing to
  // say about them.
  it('leaves every measurement null when the tools are not there', async () => {
    const fixture = await createTestApp();
    const dir = path.join(fixture.capturesDir, 'audio');
    fs.mkdirSync(dir, { recursive: true });
    const hash = 'b'.repeat(64);
    fs.writeFileSync(path.join(dir, `${hash}.wav`), wavBytes());
    const missing = async () => ({ code: null, stdout: '', stderr: 'ENOENT', failed: true });
    const measured = await analyzeRecording(fixture.capturesDir, hash, 'wav', { run: missing });
    expect(measured).toEqual({
      duration_seconds: null,
      sample_rate: null,
      channel_count: null,
      peak_dbfs: null,
      rms_dbfs: null,
      waveform_hash: null,
    });
  });
});

describe('POST /api/audio', () => {
  it('stores an upload against a module, measured and drawn', async () => {
    const fixture = await fixtureWithModule({ runImpl: fakeAudioTools() });
    const res = await upload(fixture, {
      module_id: fixture.module.id,
      filename: 'sub-out.wav',
      data_base64: WAV_BASE64,
      title: 'Sub out',
      caption: 'sounds thin',
    });
    expect(res.status).toBe(201);
    expect(res.body.module_id).toBe(fixture.module.id);
    expect(res.body.source).toBe('upload');
    expect(res.body.audio_format).toBe('wav');
    expect(res.body.original_name).toBe('sub-out.wav');
    expect(res.body.duration_seconds).toBe(12.5);
    expect(res.body.peak_dbfs).toBe(-1.5);
    expect(res.body.url).toBe(`/api/audio/${res.body.id}/file`);
    expect(res.body.waveform_url).toBe(`/api/audio/${res.body.id}/waveform`);

    const list = await request(fixture.app)
      .get(`/api/audio?module_id=${fixture.module.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(list.body).toHaveLength(1);
  });

  it('keeps a take recorded in the browser as such', async () => {
    const fixture = await fixtureWithModule({ runImpl: fakeAudioTools() });
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]);
    const res = await upload(fixture, {
      module_id: fixture.module.id,
      source: 'browser',
      data_base64: webm.toString('base64'),
    });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe('browser');
    expect(res.body.audio_format).toBe('webm');
  });

  // 'device' is what the scope route writes; a browser may not claim it.
  it('refuses to let an upload call itself a device recording', async () => {
    const fixture = await fixtureWithModule({ runImpl: fakeAudioTools() });
    const res = await upload(fixture, {
      module_id: fixture.module.id,
      source: 'device',
      data_base64: WAV_BASE64,
    });
    expect(res.body.source).toBe('upload');
  });

  it('refuses bytes that are not audio, and a recording of nothing', async () => {
    const fixture = await fixtureWithModule({ runImpl: fakeAudioTools() });
    const notAudio = await upload(fixture, {
      module_id: fixture.module.id,
      data_base64: Buffer.from('%PDF-1.4 hello there').toString('base64'),
    });
    expect(notAudio.status).toBe(400);
    expect(notAudio.body.error).toMatch(/not audio/);

    const nowhere = await upload(fixture, { data_base64: WAV_BASE64 });
    expect(nowhere.status).toBe(400);

    const both = await upload(fixture, {
      module_id: fixture.module.id,
      patch_id: 1,
      data_base64: WAV_BASE64,
    });
    expect(both.status).toBe(400);
  });

  it('refuses a module that is not in the racks of the person asking', async () => {
    const fixture = await fixtureWithModule({ runImpl: fakeAudioTools() });
    await createUser(fixture.db, { username: 'bob' });
    const bobCookie = await login(fixture.app, 'bob');
    const res = await request(fixture.app)
      .post('/api/audio')
      .set('Cookie', bobCookie)
      .send({ module_id: fixture.module.id, data_base64: WAV_BASE64 });
    expect(res.status).toBe(404);
  });
});

describe('serving and deleting a recording', () => {
  it('streams the bytes, answers a range, and is private to the owner', async () => {
    const fixture = await fixtureWithModule({ runImpl: fakeAudioTools() });
    const created = await upload(fixture, {
      module_id: fixture.module.id,
      data_base64: WAV_BASE64,
    });
    const id = created.body.id;

    const whole = await request(fixture.app)
      .get(`/api/audio/${id}/file`)
      .set('Cookie', fixture.aliceCookie);
    expect(whole.status).toBe(200);
    expect(whole.headers['content-type']).toBe('audio/wav');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['cache-control']).toMatch(/immutable/);

    const part = await request(fixture.app)
      .get(`/api/audio/${id}/file`)
      .set('Cookie', fixture.aliceCookie)
      .set('Range', 'bytes=0-9');
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toMatch(/^bytes 0-9\//);

    const waveform = await request(fixture.app)
      .get(`/api/audio/${id}/waveform`)
      .set('Cookie', fixture.aliceCookie);
    expect(waveform.status).toBe(200);
    expect(waveform.headers['content-type']).toBe('image/png');

    await createUser(fixture.db, { username: 'bob' });
    const bobCookie = await login(fixture.app, 'bob');
    const stolen = await request(fixture.app).get(`/api/audio/${id}/file`).set('Cookie', bobCookie);
    expect(stolen.status).toBe(404);
  });

  it('deletes the files only once nothing points at those bytes', async () => {
    const fixture = await fixtureWithModule({ runImpl: fakeAudioTools() });
    const first = await upload(fixture, { module_id: fixture.module.id, data_base64: WAV_BASE64 });
    const second = await upload(fixture, { module_id: fixture.module.id, data_base64: WAV_BASE64 });
    const stored = await fixture.db.models.AudioRecording.findByPk(first.body.id);
    const file = audioPath(fixture.capturesDir, stored.audio_hash, 'wav');
    expect(fs.existsSync(file)).toBe(true);

    await request(fixture.app)
      .delete(`/api/audio/${first.body.id}`)
      .set('Cookie', fixture.aliceCookie);
    // The second recording is the same bytes: the file stays.
    expect(fs.existsSync(file)).toBe(true);

    await request(fixture.app)
      .delete(`/api/audio/${second.body.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('renames a recording without touching the sound', async () => {
    const fixture = await fixtureWithModule({ runImpl: fakeAudioTools() });
    const created = await upload(fixture, { module_id: fixture.module.id, data_base64: WAV_BASE64 });
    const res = await request(fixture.app)
      .put(`/api/audio/${created.body.id}`)
      .set('Cookie', fixture.aliceCookie)
      .send({ title: 'Take 3', caption: '' });
    expect(res.body.title).toBe('Take 3');
    expect(res.body.caption).toBeNull();
    expect(res.body.audio_format).toBe('wav');
  });
});

describe('recording from the oscilloscope', () => {
  it('records audio of a patch and files it under the patch', async () => {
    const fixture = await fixtureWithModule({ runImpl: fakeAudioTools() });
    const alice = await fixture.db.models.User.findOne({ where: { username: 'alice' } });
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: alice.id,
      state: {
        capabilities: ['capture', 'record', 'record_audio'],
        audio_device: { id: 'iface', name: 'Scarlett', sample_rate: 48000 },
        channels: [{ index: 0, label: 'CH1' }],
      },
      answers: {
        record_audio: () => ({
          audio: { format: 'wav', data: WAV_BASE64, duration_seconds: 15 },
          captured_at: '2026-01-02T03:04:05.000Z',
        }),
      },
    });
    const { rows: racks } = await fixture.db.query('SELECT id FROM racks WHERE user_id = $1', [
      alice.id,
    ]);
    const patch = await request(fixture.app)
      .post('/api/patches')
      .set('Cookie', fixture.aliceCookie)
      .send({ rack_id: racks[0].id, name: 'Krell' });

    const res = await request(fixture.app)
      .post(`/api/scope/patches/${patch.body.id}/audio`)
      .set('Cookie', fixture.aliceCookie)
      .send({ duration_seconds: 15 });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe('device');
    expect(res.body.patch_id).toBe(patch.body.id);
    expect(res.body.device_name).toBe('CVOsc');
    expect(res.body.audio_device_name).toBe('Scarlett');
    expect(res.body.duration_seconds).toBe(12.5);
  });

  it('refuses cleanly when the device cannot record audio', async () => {
    const fixture = await fixtureWithModule({ runImpl: fakeAudioTools() });
    const alice = await fixture.db.models.User.findOne({ where: { username: 'alice' } });
    await connectFakeDevice(fixture.hub, fixture.db, {
      userId: alice.id,
      state: { capabilities: ['capture'], channels: [{ index: 0 }] },
    });
    const res = await request(fixture.app)
      .post(`/api/scope/modules/${fixture.module.id}/audio`)
      .set('Cookie', fixture.aliceCookie)
      .send({ channels: [0] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/does not support recording audio/);
  });

  it('rejects an unusable answer as the fault of the device', () => {
    expect(() => parseAudioResult({})).toThrow(/no audio data/);
    expect(() => parseAudioResult({ audio: { format: 'aiff', data: 'x' } })).toThrow(/unsupported/);
    expect(() =>
      parseAudioResult({ audio: { data: Buffer.from('nope!nope!nope').toString('base64') } })
    ).toThrow(/not a format/);
    // Declared as one thing, actually another.
    expect(() => parseAudioResult({ audio: { format: 'mp3', data: WAV_BASE64 } })).toThrow(/but was declared/);
  });

  it('clamps how long the scope may be asked to record for', () => {
    expect(clampRecordDuration(9999)).toBe(120);
    expect(clampRecordDuration(0)).toBe(1);
    expect(clampRecordDuration('nonsense')).toBe(15);
  });
});

describe('a recording as an answer document', () => {
  it('writes out everything the picture shows', () => {
    const text = audioTextDocument(
      {
        id: 4,
        title: 'Buzzy bass',
        source: 'browser',
        duration_seconds: 8,
        sample_rate: 48000,
        channel_count: 2,
        peak_dbfs: 0,
        rms_dbfs: -14.2,
        audio_format: 'wav',
        caption: 'the low notes rattle',
        waveform_hash: 'c'.repeat(64),
        recorded_at: new Date('2026-02-03T00:00:00Z'),
      },
      { moduleName: 'Make Noise Maths' }
    );
    expect(text).toContain('Buzzy bass');
    expect(text).toContain('Make Noise Maths');
    expect(text).toContain('48000 Hz');
    expect(text).toContain('clipping');
    expect(text).toContain('the low notes rattle');
    expect(text).toContain('spectrogram');
  });

  it('says so when there is no picture to look at', () => {
    const text = audioTextDocument({ id: 5, source: 'upload', waveform_hash: null });
    expect(text).toContain('No picture of this recording could be rendered');
  });
});

describe('attaching a recording to a question', () => {
  it('offers it in the review step, saves it, and sends its picture to the model', async () => {
    const fixture = await fixtureWithModule({ runImpl: fakeAudioTools() });
    const created = await upload(fixture, {
      module_id: fixture.module.id,
      data_base64: WAV_BASE64,
      title: 'Sub out',
    });
    expect(created.status).toBe(201);

    const { Question, QuestionModule } = fixture.db.models;
    const alice = await fixture.db.models.User.findOne({ where: { username: 'alice' } });
    const question = await Question.create({
      user_id: alice.id,
      prompt: 'why is it thin?',
      status: 'scoped',
    });
    await QuestionModule.create({ question_id: question.id, module_id: fixture.module.id });

    const options = await request(fixture.app)
      .get(`/api/questions/${question.id}/options`)
      .set('Cookie', fixture.aliceCookie);
    expect(options.body.audio).toHaveLength(1);
    expect(options.body.audio[0].module_ids).toContain(fixture.module.id);

    const answered = await request(fixture.app)
      .post(`/api/questions/${question.id}/answer`)
      .set('Cookie', fixture.aliceCookie)
      .send({ module_ids: [fixture.module.id], audio_ids: [created.body.id] });
    expect(answered.status).toBe(200);

    const detail = await request(fixture.app)
      .get(`/api/questions/${question.id}`)
      .set('Cookie', fixture.aliceCookie);
    expect(detail.body.audio).toHaveLength(1);
    expect(detail.body.audio[0].title).toBe('Sub out');

    // Answering sends the document AND the rendered picture.
    const backend = fakeBackend({ answerWithDocuments: 'because the sub is quiet' });
    await answerQuestion(fixture.db, backend, await Question.findByPk(question.id), fixture.manualsDir, {
      capturesDir: fixture.capturesDir,
    });
    const [prompt, manuals, textDocs, imagePaths] = backend.calls.answerWithDocuments[0];
    expect(prompt).toContain('recordings of what it actually sounds like');
    expect(manuals).toEqual([]);
    expect(textDocs.some((d) => d.name === `recording-${created.body.id}.md`)).toBe(true);
    expect(imagePaths).toHaveLength(1);
    expect(imagePaths[0]).toMatch(/\.png$/);
  });

  it('refuses a recording that is about none of the selected modules', async () => {
    const fixture = await fixtureWithModule({ runImpl: fakeAudioTools() });
    const alice = await fixture.db.models.User.findOne({ where: { username: 'alice' } });
    const other = await insertModule(fixture.db, alice.id, { manufacturer: 'ALM', name: 'Pam' });
    const created = await upload(fixture, { module_id: other.id, data_base64: WAV_BASE64 });

    const { Question, QuestionModule } = fixture.db.models;
    const question = await Question.create({
      user_id: alice.id,
      prompt: 'why is it thin?',
      status: 'scoped',
    });
    await QuestionModule.create({ question_id: question.id, module_id: fixture.module.id });

    const res = await request(fixture.app)
      .post(`/api/questions/${question.id}/answer`)
      .set('Cookie', fixture.aliceCookie)
      .send({ module_ids: [fixture.module.id], audio_ids: [created.body.id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/recordings of the selected modules/);
  });
});
