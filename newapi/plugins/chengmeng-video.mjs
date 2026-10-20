// Chengmeng's task API is not OpenAI-compatible; keep its async task flow isolated here.
export const meta = {
    apiVersion: 1,
    key: 'studio-chengmeng-video',
    name: 'Chengmeng 视频',
    version: '1.0.0',
    author: { name: 'Inspire Studio' },
    description: { en: 'Chengmeng async video tasks', zh: 'Chengmeng 异步视频任务' },
    models: ['sd-2.5-lw-按次', 'sd-2.0-按次'],
    fetchMode: 'per_task',
    protocols: ['openai_video'],
    allowedHosts: ['api.chengmeng.site'],
};

const check = (condition, message) => { if (!condition) throw new Error(message); };
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const object = value => isObject(value) ? value : {};
const list = value => Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
const text = value => String(value == null ? '' : value).trim();

function apiRoot(baseUrl) {
    const raw = text(baseUrl).replace(/\/+$/, '');
    check(raw, 'Chengmeng API base URL is missing');
    let parsed;
    try { parsed = new URL(raw); } catch { throw new Error('Chengmeng API base URL is invalid'); }
    check(['http:', 'https:'].includes(parsed.protocol), 'Chengmeng API base URL must use HTTP(S)');
    return raw.replace(/\/(?:api\/)?v1$/i, '').replace(/\/api$/i, '');
}

function apiUrl(baseUrl, path) {
    return apiRoot(baseUrl) + '/api' + path;
}

function auth(ctx) {
    check(text(ctx.apiKey), 'Chengmeng channel token is not configured');
    return { Authorization: 'Bearer ' + ctx.apiKey };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function decode(ctx) {
    check(ctx.body && ['json', 'multipart'].includes(ctx.body.kind), 'Submit JSON or multipart video input');
    let req;
    if (ctx.body.kind === 'json') {
        req = clone(ctx.body.value);
    } else {
        req = {};
        const fields = ctx.body.fields || {};
        for (const key of Object.keys(fields)) {
            check(Array.isArray(fields[key]) && fields[key].length === 1, 'Repeated parameter: ' + key);
            req[key] = fields[key][0];
        }
        for (const key of ['images', 'reference_images', 'reference_image_roles', 'metadata', 'values', 'options', 'videos', 'audio']) {
            if (req[key] !== undefined) {
                try { req[key] = JSON.parse(req[key]); } catch { throw new Error('Invalid JSON field: ' + key); }
            }
        }
        // Multipart files cannot be forwarded as inline data: Chengmeng requires public image URLs.
        req._chengmengUploadedFiles = (ctx.body.files || []).length;
    }
    check(isObject(req), 'Video input must be a JSON object');
    check(text(req.prompt), 'Video prompt is required');
    return req;
}

function imageUrls(req) {
    const metadata = object(req.metadata);
    const values = list(req.images || req.reference_images || metadata.reference_images || req.input_reference || req.image);
    return publicUrls(values, 'reference images');
}

function publicUrls(values, label) {
    return list(values).map(value => {
        const candidate = isObject(value) ? value.image_url || value.url : value;
        check(typeof candidate === 'string' && candidate.trim(), 'Chengmeng ' + label + ' must be public HTTPS URLs');
        let parsed;
        try { parsed = new URL(candidate); } catch { throw new Error('Chengmeng ' + label + ' must be public HTTPS URLs'); }
        check(parsed.protocol === 'https:' && parsed.hostname, 'Chengmeng ' + label + ' must be public HTTPS URLs');
        return parsed.toString();
    });
}

function numericModelId(ctx) {
    const candidate = ctx.upstreamModel || object(ctx.requestBody).model_id || ctx.model;
    const value = text(candidate);
    check(/^[1-9]\d*$/.test(value), 'Map each Chengmeng video model to its numeric account model ID in New API');
    const id = Number(value);
    check(Number.isSafeInteger(id), 'Chengmeng model ID must be a safe integer');
    return id;
}

function extensionValues(req) {
    const values = { ...object(req.values) };
    const known = ['omni_reference_task_type', 'generate_audio', 'watermark', 'output_format', 'priority', 'tools', 'execution_expires_after'];
    for (const source of [object(req.options), object(req.metadata), req]) {
        for (const key of known) if (source[key] !== undefined && values[key] === undefined) values[key] = source[key];
    }
    const videos = list(req.videos || object(req.metadata).reference_videos);
    const audioUrls = list(req.audio || req.reference_audios || object(req.metadata).reference_audios);
    if (videos.length && values.videos === undefined) values.videos = videos;
    if (audioUrls.length && values.audioUrls === undefined) values.audioUrls = audioUrls;
    if (values.videos !== undefined) values.videos = publicUrls(values.videos, 'reference videos');
    if (values.audioUrls !== undefined) values.audioUrls = publicUrls(values.audioUrls, 'reference audio');
    return Object.keys(values).length ? values : undefined;
}

function taskData(body) {
    let data = object(body);
    for (let depth = 0; depth < 3 && isObject(data.data); depth++) data = data.data;
    return data;
}

function assertApiSuccess(resp) {
    check(!Number.isFinite(Number(resp.statusCode)) || Number(resp.statusCode) < 400,
        object(resp.body).message || object(resp.body).error_message || 'Chengmeng API request failed');
    const body = object(resp.body);
    if (body.code !== undefined) check(String(body.code) === '0', body.message || body.error_message || 'Chengmeng API returned an error');
}

export const protocols = {
    openai_video: {
        decodeRequest(ctx) {
            const req = decode(ctx);
            const refs = imageUrls(req);
            check(!req._chengmengUploadedFiles || refs.length, 'Upload the reference image to public HTTPS storage before using Chengmeng');
            return {
                kind: 'submit',
                model: ctx.model,
                action: req.video_generation_mode || (refs.length ? 'image-to-video' : 'text-to-video'),
                requestBody: req,
            };
        },
        render(ctx, task) {
            const data = taskData(task.data);
            return {
                seconds: text(data.duration || data.seconds || ''),
                error: task.status === 'FAILURE' ? { message: task.fail_reason || data.error_message || 'Video generation failed' } : undefined,
            };
        },
    },
};

export function buildSubmitRequest(ctx) {
    const req = object(ctx.requestBody);
    const prompt = text(req.prompt);
    check(prompt, 'Video prompt is required');
    const duration = Number(req.duration === undefined ? req.seconds : req.duration);
    check(Number.isInteger(duration) && duration > 0, 'Chengmeng duration must be a positive integer');
    const resolution = text(req.resolution || req.resolution_name);
    check(resolution, 'Chengmeng requires an explicit video resolution');
    const refs = imageUrls(req);
    check(!req._chengmengUploadedFiles || refs.length, 'Upload the reference image to public HTTPS storage before using Chengmeng');

    const body = {
        model_id: numericModelId(ctx),
        prompt,
        duration,
        resolution,
    };
    const aspectRatio = text(req.aspect_ratio || object(req.metadata).aspect_ratio);
    if (aspectRatio) body.aspect_ratio = aspectRatio;
    if (refs.length) body.images = refs;
    const values = extensionValues(req);
    if (values) body.values = values;

    return {
        url: apiUrl(ctx.baseUrl, '/tasks'),
        method: 'POST',
        headers: { ...auth(ctx), 'Content-Type': 'application/json' },
        body,
    };
}

export function parseSubmitResponse(ctx, resp) {
    assertApiSuccess(resp);
    const data = taskData(resp.body);
    const taskId = data.task_no || data.task_id || data.id;
    check(taskId !== undefined && taskId !== null && text(taskId), 'Chengmeng did not return a task number');
    return { taskId: String(taskId), taskData: data, state: { seconds: ctx.requestBody.duration || ctx.requestBody.seconds } };
}

export function buildQueryRequest(ctx) {
    return {
        url: apiUrl(ctx.baseUrl, '/tasks/' + encodeURIComponent(ctx.taskId)),
        method: 'GET',
        headers: { ...auth(ctx), Accept: 'application/json' },
    };
}

export function parseTaskResult(ctx, raw) {
    assertApiSuccess({ statusCode: raw.statusCode, body: raw.body || raw });
    const body = taskData(raw.body || raw);
    const value = text(body.status).toLowerCase();
    const status = ['success', 'succeeded', 'completed', 'done'].includes(value) ? 'SUCCESS'
        : ['failed', 'failure', 'error', 'expired', 'cancelled', 'canceled'].includes(value) ? 'FAILURE'
        : ['pending', 'queued', 'waiting', 'submitted'].includes(value) ? 'QUEUED'
        : ['running', 'processing', 'in_progress', 'in progress'].includes(value) ? 'IN_PROGRESS' : 'UNKNOWN';
    return {
        status,
        progress: status === 'SUCCESS' ? '100%' : Math.min(99, Math.max(0, Number(body.progress) || 0)) + '%',
        reason: status === 'FAILURE' ? text(body.error_message || body.message || 'Chengmeng video task failed')
            : status === 'UNKNOWN' ? 'Unknown Chengmeng task status: ' + (value || '(empty)') : undefined,
    };
}

export function listArtifacts(task) {
    return task.status === 'SUCCESS' ? [{ key: 'video', type: 'video' }] : [];
}

export function buildContentRequest(ctx) {
    check(ctx.artifactKey === 'video', 'Video artifact is not available');
    const data = taskData(ctx.data);
    const target = text(data.result_url || data.download_url);
    let parsed;
    try { parsed = new URL(target); } catch { throw new Error('Chengmeng did not return a valid video URL'); }
    check(['http:', 'https:'].includes(parsed.protocol), 'Chengmeng did not return a valid video URL');
    return { url: parsed.toString(), method: ctx.clientRequest.method, credentialless: true };
}
