import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from './aixoras-video.mjs';

const base = { baseUrl: 'https://api.aixoras.com', apiKey: 'test-token', model: 'wan-3.0' };
const prompt = 'A paper boat drifts across a lake';

test('plugin advertises only the documented Aixoras wan-3.0 model on the Studio video protocol', () => {
    assert.deepEqual(plugin.meta.models, ['wan-3.0']);
    assert.deepEqual(plugin.meta.protocols, ['openai_video']);
});

test('JSON request decodes URL references and keeps the upstream aspect ratio metadata', () => {
    const decoded = plugin.protocols.openai_video.decodeRequest({
        ...base,
        body: { kind: 'json', value: { prompt, seconds: 5, size: '16:9', images: ['https://cdn.example/frame.png'], metadata: { seed: 7 } } },
    });
    assert.equal(decoded.kind, 'submit');
    assert.equal(decoded.action, 'image-to-video');
    assert.deepEqual(decoded.requestBody.images, ['https://cdn.example/frame.png']);
    assert.deepEqual(decoded.requestBody.metadata, { seed: 7 });

    const fromMetadata = plugin.protocols.openai_video.decodeRequest({
        ...base,
        body: { kind: 'json', value: { prompt, metadata: { reference_images: ['https://cdn.example/metadata-frame.png'] } } },
    });
    assert.deepEqual(fromMetadata.requestBody.images, ['https://cdn.example/metadata-frame.png']);
    assert.deepEqual(fromMetadata.requestBody.metadata, {});
});

test('multipart JSON fields are decoded and public image URLs are deduplicated', () => {
    const decoded = plugin.protocols.openai_video.decodeRequest({
        ...base,
        body: { kind: 'multipart', fields: {
            prompt: [prompt], seconds: ['5'], images: ['["https://cdn.example/frame.png"]'],
            input_reference: ['"https://cdn.example/frame.png"'], metadata: ['{"aspect_ratio":"9:16"}'],
        } },
    });
    assert.deepEqual(decoded.requestBody.images, ['https://cdn.example/frame.png']);
    const request = plugin.buildSubmitRequest({ ...base, requestBody: decoded.requestBody });
    assert.deepEqual(request.body.images, ['https://cdn.example/frame.png']);
    assert.deepEqual(request.body.metadata, { aspect_ratio: '9:16' });
});

test('multipart accepts a plain singular image URL from the OpenAI-compatible video request', () => {
    const image = 'https://cdn.example/frame.png';
    const decoded = plugin.protocols.openai_video.decodeRequest({
        ...base,
        body: { kind: 'multipart', fields: {
            prompt: [prompt], image: [image], seconds: ['5'],
        } },
    });
    assert.deepEqual(decoded.requestBody.images, [image]);
    const request = plugin.buildSubmitRequest({ ...base, requestBody: decoded.requestBody });
    assert.deepEqual(request.body.images, [image]);
});

test('multipart accepts a plain input_reference URL passed by the Studio video client', () => {
    const image = 'https://ai-video.sosour.top/ai-video/images/20261021/31f0e1dc800fb688044b96ee.png';
    const decoded = plugin.protocols.openai_video.decodeRequest({
        ...base,
        body: { kind: 'multipart', fields: {
            prompt: [prompt], input_reference: [image], seconds: ['5'],
        } },
    });
    assert.deepEqual(decoded.requestBody.images, [image]);
    const request = plugin.buildSubmitRequest({ ...base, requestBody: decoded.requestBody });
    assert.deepEqual(request.body.images, [image]);
});

test('submit uses the Aixoras async endpoint, Bearer auth and documented duration fields', () => {
    const request = plugin.buildSubmitRequest({
        ...base,
        requestBody: { prompt, seconds: '8', resolution: '720p', size: '16:9', metadata: { seed: 42 } },
    });
    assert.equal(request.url, 'https://api.aixoras.com/v1/video/generations');
    assert.equal(request.method, 'POST');
    assert.deepEqual(request.headers, { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' });
    assert.deepEqual(request.body, {
        model: 'wan-3.0', prompt, duration: 8, seconds: '8', resolution: '720p',
        metadata: { seed: 42, aspect_ratio: '16:9' },
    });
});

test('a base URL already ending in /v1 is not duplicated', () => {
    const request = plugin.buildSubmitRequest({
        ...base, baseUrl: 'https://aixoras.com/v1/', requestBody: { prompt },
    });
    assert.equal(request.url, 'https://aixoras.com/v1/video/generations');
});

test('references must be remote HTTP(S) URLs; multipart image files are accepted only with their public URL fields', () => {
    const request = value => plugin.buildSubmitRequest({ ...base, requestBody: { prompt, ...value } });
    assert.throws(() => request({ images: ['data:image/png;base64,abc'] }), /HTTP\(S\) URL/);
    assert.throws(() => request({ images: [{ __fileRef: 'file-1' }] }), /HTTP\(S\) URL/);
    assert.throws(() => request({ videos: ['https://cdn.example/ref.mp4'] }), /不支持参考视频或音频/);
    assert.throws(() => request({ audio: ['https://cdn.example/ref.mp3'] }), /不支持参考视频或音频/);
    assert.throws(() => plugin.protocols.openai_video.decodeRequest({ ...base, body: {
        kind: 'multipart', fields: { prompt: [prompt] }, files: [{ field: 'image', ref: 'file-1' }],
    } }), /缺少可由上游访问的 HTTP\(S\) 图片 URL/);
    const decoded = plugin.protocols.openai_video.decodeRequest({ ...base, body: {
        kind: 'multipart', fields: {
            prompt: [prompt], images: ['["https://cdn.example/frame.png"]'],
            image: ['https://cdn.example/frame.png'], input_reference: ['https://cdn.example/frame.png'],
        }, files: [{ field: 'image', ref: 'file-1' }],
    } });
    assert.deepEqual(decoded.requestBody.images, ['https://cdn.example/frame.png']);
    assert.throws(() => plugin.protocols.openai_video.decodeRequest({ ...base, body: {
        kind: 'multipart', fields: { prompt: [prompt] }, files: [{ field: 'audio', ref: 'audio-1' }],
    } }), /只支持图片参考/);
});

test('invalid model, prompt, duration and missing token are rejected before submission', () => {
    assert.throws(() => plugin.buildSubmitRequest({ ...base, model: 'other-model', requestBody: { prompt } }), /仅支持 wan-3.0/);
    assert.throws(() => plugin.buildSubmitRequest({ ...base, requestBody: { prompt: ' ' } }), /提示词不能为空/);
    assert.throws(() => plugin.buildSubmitRequest({ ...base, requestBody: { prompt, seconds: 0 } }), /正整数秒/);
    assert.throws(() => plugin.buildSubmitRequest({ ...base, apiKey: '', requestBody: { prompt } }), /未配置 Aixoras API Token/);
});

test('submit parses task_id or id and preserves task payload', () => {
    const response = { task_id: 'task-1', status: 'queued', model: 'wan-3.0' };
    assert.deepEqual(plugin.parseSubmitResponse({ requestBody: { seconds: '5' } }, { statusCode: 200, body: response }), {
        taskId: 'task-1', taskData: response, state: { seconds: '5' },
    });
    assert.equal(plugin.parseSubmitResponse({}, { body: { data: { id: 'task-2' } } }).taskId, 'task-2');
    assert.throws(() => plugin.parseSubmitResponse({}, { statusCode: 401, body: { error: { message: 'unauthorized' } } }), /unauthorized/);
    assert.throws(() => plugin.parseSubmitResponse({}, { statusCode: 200, body: {} }), /未返回视频任务 ID/);
});

test('query uses the documented async status endpoint and encodes task IDs', () => {
    const request = plugin.buildQueryRequest({ ...base, taskId: 'task/with space' });
    assert.equal(request.url, 'https://api.aixoras.com/v1/video/generations/task%2Fwith%20space');
    assert.equal(request.method, 'GET');
    assert.deepEqual(request.headers, { Authorization: 'Bearer test-token' });
});

test('task states and progress map to NewAPI plugin statuses', () => {
    const status = value => plugin.parseTaskResult({}, value);
    assert.deepEqual(status({ status: 'queued', progress: 0 }), { status: 'QUEUED', progress: '0%', reason: undefined });
    assert.deepEqual(status({ status: 'in_progress', progress: 45 }), { status: 'IN_PROGRESS', progress: '45%', reason: undefined });
    assert.deepEqual(status({ status: 'completed', progress: 99 }), { status: 'SUCCESS', progress: '100%', reason: undefined });
    assert.equal(status({ status: 'failed', error: { message: 'provider error' } }).reason, 'provider error');
    assert.equal(status({ status: 'unexpected' }).status, 'UNKNOWN');
    assert.equal(status({ data: { status: 'in_progress', progress: 120 } }).progress, '99%');
});

test('completed task exposes metadata.url as credentialless CDN content', () => {
    const task = plugin.parseTaskResult({}, { status: 'completed', metadata: { url: 'https://cdn.example/video.mp4' } });
    assert.deepEqual(plugin.listArtifacts(task), [{ key: 'video', type: 'video' }]);
    const content = plugin.buildContentRequest({
        ...base, artifactKey: 'video', data: { status: 'completed', metadata: { url: 'https://cdn.example/video.mp4' } },
        clientRequest: { method: 'GET' },
    });
    assert.equal(content.url, 'https://cdn.example/video.mp4');
    assert.equal(content.credentialless, true);
    assert.equal(content.headers, undefined);
});

test('same-origin media keeps auth, while a missing or non-HTTPS video URL is rejected', () => {
    const content = plugin.buildContentRequest({
        ...base, artifactKey: 'video', data: { metadata: { url: 'https://api.aixoras.com/files/video.mp4' } },
        clientRequest: { method: 'HEAD' },
    });
    assert.deepEqual(content, {
        url: 'https://api.aixoras.com/files/video.mp4', method: 'HEAD', headers: { Authorization: 'Bearer test-token' },
    });
    assert.throws(() => plugin.buildContentRequest({ ...base, artifactKey: 'video', data: {}, clientRequest: { method: 'GET' } }), /尚未返回 HTTPS 视频地址/);
    assert.throws(() => plugin.buildContentRequest({ ...base, artifactKey: 'image', data: {}, clientRequest: { method: 'GET' } }), /视频文件不存在/);
});
