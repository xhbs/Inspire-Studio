import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from './chengmeng-video.mjs';

const base = {
    baseUrl: 'https://api.chengmeng.site/v1',
    apiKey: 'unit-test-token',
    model: 'sd-2.5-lw-按次',
    upstreamModel: '103',
};

function requestBody(patch = {}) {
    return {
        prompt: 'A calm scene at sunrise',
        duration: 5,
        seconds: '5',
        resolution: '720p',
        metadata: { aspect_ratio: '16:9' },
        ...patch,
    };
}

test('plugin advertises only the two Chengmeng video models', () => {
    assert.deepEqual(plugin.meta.models, ['sd-2.5-lw-按次', 'sd-2.0-按次']);
    assert.ok(plugin.meta.protocols.includes('openai_video'));
    assert.ok(!plugin.meta.models.some(model => model.startsWith('gpt-image')));
});

test('submit maps the configured numeric account model ID and Studio fields to Chengmeng task API', () => {
    const ctx = {
        ...base,
        model: 'sd-2.5-lw-按次',
        requestBody: requestBody({ images: ['https://media.example/frame.png'], options: { watermark: false } }),
    };
    const result = plugin.buildSubmitRequest(ctx);

    assert.equal(result.url, 'https://api.chengmeng.site/api/tasks');
    assert.equal(result.method, 'POST');
    assert.equal(result.headers.Authorization, 'Bearer unit-test-token');
    assert.equal(result.headers['Content-Type'], 'application/json');
    assert.deepEqual(result.body, {
        model_id: 103,
        prompt: 'A calm scene at sunrise',
        duration: 5,
        resolution: '720p',
        aspect_ratio: '16:9',
        images: ['https://media.example/frame.png'],
        values: { watermark: false },
    });
});

test('base URL normalization avoids duplicate API and v1 path segments', () => {
    for (const baseUrl of [
        'https://api.chengmeng.site',
        'https://api.chengmeng.site/api',
        'https://api.chengmeng.site/api/v1',
        'https://api.chengmeng.site/v1/',
    ]) {
        const result = plugin.buildSubmitRequest({ ...base, baseUrl, requestBody: requestBody() });
        assert.equal(result.url, 'https://api.chengmeng.site/api/tasks');
    }
});

test('URL validation works without the WHATWG URL global used by the New API sandbox', () => {
    const originalURL = globalThis.URL;
    const signedImage = 'https://media.example/frame.png?signature=a%2Fb';
    const signedVideo = 'https://cdn.example/video.mp4?token=x%2Fy';
    try {
        globalThis.URL = undefined;
        const request = plugin.buildSubmitRequest({
            ...base,
            requestBody: requestBody({ images: [signedImage] }),
        });
        assert.equal(request.url, 'https://api.chengmeng.site/api/tasks');
        assert.deepEqual(request.body.images, [signedImage]);

        const content = plugin.buildContentRequest({
            artifactKey: 'video',
            data: { result_url: signedVideo },
            clientRequest: { method: 'GET' },
        });
        assert.equal(content.url, signedVideo);
    } finally {
        globalThis.URL = originalURL;
    }
});

test('decode accepts documented JSON and multipart fields while requiring public HTTPS image URLs', () => {
    const decoded = plugin.protocols.openai_video.decodeRequest({
        ...base,
        body: { kind: 'json', value: requestBody({ images: [{ image_url: 'https://media.example/a.png' }] }) },
    });
    assert.equal(decoded.kind, 'submit');
    assert.equal(decoded.action, 'image-to-video');
    assert.deepEqual(plugin.buildSubmitRequest({ ...base, requestBody: decoded.requestBody }).body.images,
        ['https://media.example/a.png']);

    const multipart = plugin.protocols.openai_video.decodeRequest({
        ...base,
        body: {
            kind: 'multipart',
            fields: {
                prompt: ['Animate this frame'],
                duration: ['5'],
                resolution: ['720p'],
                metadata: ['{"aspect_ratio":"9:16"}'],
                images: ['["https://media.example/frame.png"]'],
            },
            files: [{ field: 'image', ref: 'local-file' }],
        },
    });
    assert.deepEqual(plugin.buildSubmitRequest({ ...base, requestBody: multipart.requestBody }).body.images,
        ['https://media.example/frame.png']);
    assert.throws(() => plugin.protocols.openai_video.decodeRequest({
        ...base,
        body: { kind: 'multipart', fields: { prompt: ['Animate'] }, files: [{ field: 'image', ref: 'local-file' }] },
    }), /public HTTPS storage/);
    for (const image of ['data:image/png;base64,AA==', 'http://media.example/frame.png', 'not-a-url']) {
        assert.throws(() => plugin.buildSubmitRequest({ ...base, requestBody: requestBody({ images: [image] }) }), /public HTTPS URLs/);
    }
});

test('model ID comes from the New API channel mapping and must be a numeric Chengmeng account ID', () => {
    const ctx = { ...base, upstreamModel: '209', requestBody: requestBody() };
    assert.equal(plugin.buildSubmitRequest(ctx).body.model_id, 209);
    for (const invalid of ['sd-2.5-lw-按次', '0', '-1', '1.5', '9007199254740992']) {
        assert.throws(() => plugin.buildSubmitRequest({ ...ctx, upstreamModel: invalid }), /numeric account model ID|safe integer/);
    }
});

test('required prompt, duration and resolution are validated before dispatch', () => {
    for (const patch of [
        { prompt: '  ' },
        { duration: 0 },
        { duration: 2.5 },
        { resolution: '' },
    ]) {
        assert.throws(() => plugin.buildSubmitRequest({ ...base, requestBody: requestBody(patch) }));
    }
    assert.throws(() => plugin.buildSubmitRequest({ ...base, apiKey: '', requestBody: requestBody() }), /token is not configured/);
});

test('extension values use Chengmeng values envelope and preserve video/audio URL inputs', () => {
    const result = plugin.buildSubmitRequest({
        ...base,
        requestBody: requestBody({
            videos: ['https://media.example/reference.mp4'],
            audio: ['https://media.example/reference.mp3'],
            values: { omni_reference_task_type: 'reference' },
        }),
    });
    assert.deepEqual(result.body.values, {
        omni_reference_task_type: 'reference',
        videos: ['https://media.example/reference.mp4'],
        audioUrls: ['https://media.example/reference.mp3'],
    });
    assert.throws(() => plugin.buildSubmitRequest({
        ...base,
        requestBody: requestBody({ videos: ['data:video/mp4;base64,AA=='] }),
    }), /reference videos must be public HTTPS URLs/);
});

test('submit and query parse Chengmeng async task envelopes and statuses', () => {
    const submitted = plugin.parseSubmitResponse({ requestBody: requestBody() }, {
        statusCode: 200,
        body: { code: 0, data: { task_no: 'task_123', status: 'pending' } },
    });
    assert.equal(submitted.taskId, 'task_123');

    assert.deepEqual(plugin.buildQueryRequest({ ...base, taskId: 'task/123' }), {
        url: 'https://api.chengmeng.site/api/tasks/task%2F123',
        method: 'GET',
        headers: { Authorization: 'Bearer unit-test-token', Accept: 'application/json' },
    });
    assert.equal(plugin.parseTaskResult({}, { body: { code: 0, data: { status: 'pending', progress: 4 } } }).status, 'QUEUED');
    assert.equal(plugin.parseTaskResult({}, { body: { code: 0, data: { status: 'running', progress: 55 } } }).progress, '55%');
    assert.equal(plugin.parseTaskResult({}, { body: { code: 0, data: { status: 'success' } } }).status, 'SUCCESS');
    assert.equal(plugin.parseTaskResult({}, { body: { code: 0, data: { status: 'failed', error_message: 'upstream error' } } }).reason, 'upstream error');
    assert.equal(plugin.parseTaskResult({}, { body: { code: 0, data: { status: 'expired' } } }).status, 'FAILURE');
    assert.throws(() => plugin.parseSubmitResponse({}, { statusCode: 200, body: { code: 9, message: 'no access' } }), /no access/);
    assert.throws(() => plugin.parseSubmitResponse({}, { statusCode: 200, body: { code: 0, data: {} } }), /task number/);
});

test('successful tasks expose result/download URL without forwarding the Chengmeng token', () => {
    assert.deepEqual(plugin.listArtifacts({ status: 'SUCCESS' }), [{ key: 'video', type: 'video' }]);
    assert.deepEqual(plugin.listArtifacts({ status: 'IN_PROGRESS' }), []);
    const content = plugin.buildContentRequest({
        artifactKey: 'video',
        data: { code: 0, data: { result_url: 'https://cdn.example/video.mp4' } },
        clientRequest: { method: 'GET' },
    });
    assert.equal(content.url, 'https://cdn.example/video.mp4');
    assert.equal(content.credentialless, true);
    assert.equal(content.headers, undefined);
    assert.throws(() => plugin.buildContentRequest({ artifactKey: 'image', data: {}, clientRequest: { method: 'GET' } }));
    assert.throws(() => plugin.buildContentRequest({ artifactKey: 'video', data: {}, clientRequest: { method: 'GET' } }));
});
