// Aixoras NewAPI video endpoint adapter for the wan-3.0 model.
export const meta = {
    apiVersion: 1,
    key: 'studio-aixoras-video',
    name: 'Aixoras wan-3.0 视频',
    version: '1.0.0',
    author: { name: 'Inspire Studio' },
    fetchMode: 'per_task',
    protocols: ['openai_video'],
    upstreams: ['vendor', 'new_api'],
    models: ['wan-3.0'],
};

const fail = (condition, message) => { if (!condition) throw new Error(message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const asArray = value => Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
const text = value => String(value === undefined || value === null ? '' : value).trim();
const object = value => isObject(value) ? value : {};

function parseJsonField(value, field) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); }
    catch {
        // NewAPI may pass reference URL fields as plain text in multipart requests.
        if (['image', 'input_reference'].includes(field) && /^https?:\/\//i.test(value.trim())) return value.trim();
        throw new Error('参数 ' + field + ' 必须是合法 JSON');
    }
}

function requestFromBody(ctx) {
    fail(ctx.body && ['json', 'multipart'].includes(ctx.body.kind), '请提交 JSON 或 multipart 请求');
    if (ctx.body.kind === 'json') {
        fail(isObject(ctx.body.value), '请求体必须是 JSON 对象');
        return JSON.parse(JSON.stringify(ctx.body.value));
    }

    const req = {};
    const fields = ctx.body.fields || {};
    for (const key of Object.keys(fields)) {
        fail(Array.isArray(fields[key]) && fields[key].length === 1, '重复参数: ' + key);
        req[key] = fields[key][0];
    }
    for (const key of ['metadata', 'options', 'images', 'image', 'input_reference', 'reference_images', 'videos', 'audio']) {
        if (req[key] !== undefined) req[key] = parseJsonField(req[key], key);
    }
    const files = ctx.body.files || [];
    fail(files.every(file => ['image', 'input_reference', 'reference_images'].includes(file.field)),
        'Aixoras 视频接口当前只支持图片参考');
    return req;
}

function parseMetadata(value) {
    const parsed = typeof value === 'string' ? parseJsonField(value, 'metadata') : value;
    fail(parsed === undefined || isObject(parsed), 'metadata 必须是 JSON 对象');
    return { ...object(parsed) };
}

function imageUrls(req, metadata) {
    const candidates = [
        ...asArray(req.images), ...asArray(req.image), ...asArray(req.input_reference),
        ...asArray(req.reference_images), ...asArray(metadata.reference_images),
    ];
    const urls = [];
    for (const candidate of candidates) {
        const value = typeof candidate === 'string' ? candidate
            : object(candidate).image_url?.url || object(candidate).url;
        fail(typeof value === 'string' && /^https?:\/\//i.test(value), 'Aixoras 参考图必须是上游可访问的 HTTP(S) URL');
        if (!urls.includes(value)) urls.push(value);
    }
    return urls;
}

function endpoint(ctx, path) {
    const base = text(ctx.baseUrl);
    fail(/^https?:\/\//i.test(base), 'Aixoras Base URL 必须是 HTTP(S) URL');
    return base.replace(/\/+$/, '').replace(/\/v1$/i, '') + path;
}

function auth(ctx) {
    const key = text(ctx.apiKey);
    fail(key, '未配置 Aixoras API Token');
    return { Authorization: 'Bearer ' + key };
}

function resultVideoUrl(value) {
    const queue = [value];
    const seen = new Set();
    for (let index = 0; index < queue.length && index < 32; index++) {
        const item = queue[index];
        if (!isObject(item) || seen.has(item)) continue;
        seen.add(item);
        const metadata = object(item.metadata);
        const target = text(metadata.url || item.result_url || item.video_url || item.download_url || item.output_url
            || item.content_url || item.url || object(item.video).url || object(item.output).url || object(item.result).url);
        if (/^https?:\/\//i.test(target)) return target;
        for (const key of ['data', 'result', 'output', 'video', 'task', 'response']) {
            if (isObject(item[key])) queue.push(item[key]);
        }
    }
    return '';
}

export const protocols = {
    openai_video: {
        decodeRequest(ctx) {
            const req = requestFromBody(ctx);
            const metadata = parseMetadata(req.metadata);
            const images = imageUrls(req, metadata);
            fail(!(ctx.body.files || []).length || images.length > 0,
                '上传的参考图缺少可由上游访问的 HTTP(S) 图片 URL');
            delete metadata.reference_images;
            const mode = text(req.video_generation_mode) || (images.length ? 'image-to-video' : 'text-to-video');
            return { kind: 'submit', model: ctx.model, action: mode, requestBody: { ...req, metadata, images } };
        },
        render(ctx, task) {
            const data = object(task.data);
            const seconds = data.duration ?? data.seconds ?? object(task.state).seconds ?? '';
            return {
                seconds: text(seconds),
                error: task.status === 'FAILURE' ? { message: task.fail_reason || '视频生成失败' } : undefined,
            };
        },
    },
};

export function buildSubmitRequest(ctx) {
    const req = object(ctx.requestBody);
    const model = text(ctx.upstreamModel || ctx.model);
    fail(meta.models.includes(model), 'Aixoras 视频插件仅支持 wan-3.0');
    const prompt = text(req.prompt);
    fail(prompt, '视频提示词不能为空');
    fail(!asArray(req.videos).length && !asArray(req.audio).length && !asArray(req.reference_audios).length,
        'Aixoras wan-3.0 插件当前不支持参考视频或音频');

    const metadata = parseMetadata(req.metadata);
    fail(!asArray(metadata.reference_videos).length && !asArray(metadata.reference_audios).length,
        'Aixoras wan-3.0 插件当前不支持参考视频或音频');
    const images = imageUrls(req, metadata);
    delete metadata.reference_images;
    const body = { model, prompt };
    const rawDuration = req.duration ?? req.seconds;
    if (rawDuration !== undefined && rawDuration !== null && text(rawDuration) !== '') {
        const duration = Number(rawDuration);
        fail(Number.isSafeInteger(duration) && duration > 0, '视频时长必须是正整数秒');
        body.duration = duration;
        body.seconds = String(duration);
    }

    const resolution = text(req.resolution || req.resolution_name);
    if (resolution) body.resolution = resolution;
    const size = text(req.size);
    if (size && !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(size)) body.size = size;
    const aspectRatio = text(req.aspect_ratio || metadata.aspect_ratio || (/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(size) ? size : ''));
    if (aspectRatio) metadata.aspect_ratio = aspectRatio;
    if (Object.keys(metadata).length) body.metadata = metadata;
    if (images.length) body.images = images;
    if (req.mode !== undefined && text(req.mode)) body.mode = text(req.mode);

    return {
        url: endpoint(ctx, '/v1/video/generations'),
        method: 'POST',
        headers: { ...auth(ctx), 'Content-Type': 'application/json' },
        body,
    };
}

export function parseSubmitResponse(ctx, resp) {
    const statusCode = Number(resp.statusCode || 0);
    const wrapper = object(resp.body);
    const body = isObject(wrapper.data) ? wrapper.data : wrapper;
    fail(statusCode < 400, text(object(body.error).message || object(wrapper.error).message || body.message || wrapper.message) || 'Aixoras 视频任务提交失败');
    const taskId = body.task_id || body.id;
    fail(taskId, 'Aixoras 未返回视频任务 ID');
    return { taskId: String(taskId), taskData: body, state: { seconds: ctx.requestBody?.seconds ?? ctx.requestBody?.duration } };
}

export function buildQueryRequest(ctx) {
    fail(text(ctx.taskId), '视频任务 ID 不能为空');
    return {
        url: endpoint(ctx, '/v1/video/generations/' + encodeURIComponent(ctx.taskId)),
        method: 'GET',
        headers: auth(ctx),
    };
}

export function parseTaskResult(ctx, raw) {
    const wrapper = object(raw);
    const body = isObject(wrapper.data) ? wrapper.data : wrapper;
    const resultUrl = resultVideoUrl(raw);
    const value = text(body.status).toLowerCase();
    const status = ['completed', 'success', 'succeeded', 'done'].includes(value) ? 'SUCCESS'
        : ['failed', 'failure', 'error'].includes(value) ? 'FAILURE'
        : ['queued', 'pending', 'waiting'].includes(value) ? 'QUEUED'
        : ['in_progress', 'running', 'processing'].includes(value) ? 'IN_PROGRESS' : 'UNKNOWN';
    const rawProgress = Number.parseInt(String(body.progress ?? 0).replace(/%$/, ''), 10);
    const progress = status === 'SUCCESS' ? 100 : Math.max(0, Math.min(99, Number.isFinite(rawProgress) ? rawProgress : 0));
    const error = object(body.error);
    return {
        status,
        progress: progress + '%',
        reason: status === 'FAILURE' ? text(error.message || body.message || wrapper.message) || 'Aixoras 视频生成失败'
            : status === 'UNKNOWN' ? '未知 Aixoras 视频任务状态: ' + (value || 'empty') : undefined,
        ...(resultUrl ? { state: { resultUrl } } : {}),
    };
}

export function listArtifacts(task) {
    return task.status === 'SUCCESS' ? [{ key: 'video', type: 'video' }] : [];
}

export function buildContentRequest(ctx) {
    fail(ctx.artifactKey === 'video', '视频文件不存在');
    const target = text(ctx.state?.resultUrl || resultVideoUrl(ctx.data));
    fail(target, 'Aixoras 已完成任务，但未返回可下载的视频地址');
    fail(/^https?:\/\//i.test(target), 'Aixoras 返回的视频地址不是有效 HTTP(S) URL');
    // NewAPI's JS sandbox has no WHATWG URL global; preserve signed URLs verbatim.
    const origin = value => {
        const match = value.match(/^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?(?=[/?#]|$)/i);
        fail(match && !/[\u0000-\u0020\u007f\\]/.test(value) && !value.includes('#'),
            'Invalid HTTP(S) media URL');
        const scheme = match[1].toLowerCase();
        const host = match[2].toLowerCase();
        const port = match[3] ? Number(match[3]) : scheme === 'https' ? 443 : 80;
        fail(port > 0 && port <= 65535, 'Invalid HTTP(S) media URL port');
        return scheme + '://' + host + ':' + port;
    };
    const request = { url: target, method: ctx.clientRequest.method };
    if (origin(target) === origin(text(ctx.baseUrl))) request.headers = auth(ctx);
    else request.credentialless = true;
    return request;
}
