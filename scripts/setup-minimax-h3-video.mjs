import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { localClients } from './lib/newapi-local.mjs';

const modelName = 'MiniMax H3';
const pluginKey = 'studio-minimax-h3';
const channelName = 'New XLCSh Video Group (MiniMax H3)';
const baseUrl = 'https://new.xlcsh.top/v1';
const durations = Array.from({ length: 11 }, (_, index) => index + 5);
const { studio, admin, env, close } = await localClients();

function normalizeBaseUrl(value) {
    return String(value || '').replace(/\/+$/, '').replace(/\/v1$/i, '').toLowerCase();
}

async function verifyCatalog(apiKey) {
    let response;
    try {
        response = await fetch(baseUrl + '/models', {
            headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
            signal: AbortSignal.timeout(30000),
        });
    } catch {
        throw new Error('MiniMax H3 model catalog is unreachable; no Studio configuration changes were made');
    }
    if (!response.ok) throw new Error('MiniMax H3 model catalog returned HTTP ' + response.status + '; no Studio configuration changes were made');
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error('MiniMax H3 model catalog returned invalid JSON; no Studio configuration changes were made'); }
    const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    const names = rows.map(item => String(item?.id || item?.name || '').trim());
    assert.ok(names.some(name => name.toLowerCase() === modelName.toLowerCase()),
        'The provided credential does not expose MiniMax H3; no Studio configuration changes were made');
}

function testAdapter(source) {
    globalThis.utils = { uuid: () => '00000000-0000-4000-8000-000000000000' };
    return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')).then(plugin => {
        const textRequest = plugin.buildSubmitRequest({
            baseUrl, apiKey: 'test-only', model: modelName, requestBody: {
                prompt: 'test prompt', seconds: 15, resolution: '720p', size: '16:9', video_generation_mode: 'text-to-video',
            },
        });
        assert.equal(new URL(textRequest.url).pathname, '/v1/videos');
        assert.match(textRequest.body, /name="seconds"[\s\S]*?15/);
        assert.match(textRequest.body, /name="resolution_name"[\s\S]*?720p/);
        assert.doesNotMatch(textRequest.body, /name="n"/);
        const imageRequest = plugin.buildSubmitRequest({
            baseUrl, apiKey: 'test-only', model: modelName, requestBody: {
                prompt: 'test prompt', seconds: 5, resolution: '720p', size: '16:9', video_generation_mode: 'image-to-video',
                images: ['https://media.example/reference.png'],
            },
        });
        assert.match(imageRequest.body, /name="input_reference\[\]"[\s\S]*?https:\/\/media\.example\/reference\.png/);
        assert.equal(new URL(plugin.buildQueryRequest({ baseUrl, apiKey: 'test-only', taskId: 'task-1' }).url).pathname,
            '/v1/videos/task-1');
    });
}


const apiKey = process.env.NEWAPI_MINIMAX_H3_API_KEY || env.NEWAPI_MINIMAX_H3_API_KEY;
assert.ok(apiKey, 'Set NEWAPI_MINIMAX_H3_API_KEY in the process environment or local .env; the key is never written to source');

try {
    await verifyCatalog(apiKey);
    const template = await readFile(new URL('../newapi/plugins/video-adapter.mjs', import.meta.url), 'utf8');
    const models = [modelName];
    const version = '1.0.0+' + createHash('sha256').update(template + JSON.stringify(models) + pluginKey).digest('hex').slice(0, 12);
    const source = 'const config = ' + JSON.stringify({ key: pluginKey, name: 'MiniMax H3 OpenAI Video Adapter', protocol: 'openai', models, version }) + ';\n' + template;
    await testAdapter(source);
    await mkdir(new URL('../newapi/generated/', import.meta.url), { recursive: true });
    await writeFile(new URL('../newapi/generated/' + pluginKey + '.js', import.meta.url), source);

    await admin('/api/plugin/task', { source, enabled: true, remark: 'New XLCSh MiniMax H3 via OpenAI-compatible video API' });
    await admin('/api/plugin/task/' + pluginKey + '/activate', { version });
    const active = await admin('/api/plugin/task/' + pluginKey);
    assert.equal(active.plugin.version, version, 'MiniMax H3 video adapter did not activate');

    const pluginModels = await studio('/admin/newapi/channels/models', { type: 61, pluginKey });
    assert.ok(pluginModels.includes(modelName), 'MiniMax H3 adapter does not advertise the requested model');

    const channelPage = await studio('/admin/newapi/channels?page=1&pageSize=100&keyword=MiniMax');
    const matches = channelPage.items.filter(channel => channel.name === channelName);
    assert.ok(matches.length <= 1, 'Multiple MiniMax H3 channels exist; refusing an ambiguous update');
    const current = matches[0];
    if (current) {
        assert.equal(current.type, 61, 'Refusing to change the existing MiniMax H3 channel type');
        assert.equal(normalizeBaseUrl(current.baseUrl), normalizeBaseUrl(baseUrl),
            'Refusing to redirect the existing MiniMax H3 channel to a different host');
        assert.equal(current.pluginKey, pluginKey, 'Refusing to replace an existing channel using a different adapter');
    }
    await studio('/admin/newapi/channels/save', {
        id: current?.id,
        name: channelName,
        type: 61,
        baseUrl,
        apiKey,
        models,
        priority: current?.priority ?? 0,
        weight: current?.weight ?? 1,
        modelMapping: '{}',
        pluginKey,
    });

    const before = (await studio('/config/model/listModelConfigs')).modelConfigs;
    const defaults = before.filter(model => model.defaultModel).map(model => model.id).sort();
    await studio('/admin/newapi/models/sync', {
        models, modelType: 'video', capabilities: ['text-to-video', 'image-to-video'],
        creditCost: 8, resolutions: ['720P'], setDefault: false,
    });
    const synced = (await studio('/config/model/listModelConfigs')).modelConfigs;
    const config = synced.find(model => model.modelName === modelName && model.modelType === 'video');
    assert.ok(config, 'Studio did not create the MiniMax H3 video model profile');
    const videoBillingConfiguration = {
        ...(config.videoBillingConfiguration || {}),
        billingUnit: 'generation',
        minimumDurationSeconds: 5,
        defaultResolution: '720p',
        supportedDurationsSeconds: durations,
        modePrices: {
            'text-to-video': { '720p': 8 },
            'image-to-video': { '720p': 8 },
        },
    };
    await studio('/config/model/updateModelConfig', {
        ...config, creditCost: 8, videoBillingConfiguration,
    });

    const after = (await studio('/config/model/listModelConfigs')).modelConfigs;
    const finalConfig = after.find(model => model.modelName === modelName && model.modelType === 'video');
    assert.deepEqual(after.filter(model => model.defaultModel).map(model => model.id).sort(), defaults,
        'MiniMax H3 setup must not change the default model');
    assert.deepEqual(finalConfig.videoBillingConfiguration.supportedDurationsSeconds, durations);
    assert.equal(finalConfig.videoBillingConfiguration.defaultResolution, '720p');
    assert.equal(finalConfig.videoBillingConfiguration.modePrices['text-to-video']['720p'], 8);
    assert.equal(finalConfig.videoBillingConfiguration.modePrices['image-to-video']['720p'], 8);
    const pricedModes = Object.entries(finalConfig.videoBillingConfiguration.modePrices)
        .filter(([, prices]) => Object.keys(prices || {}).length > 0).map(([mode]) => mode).sort();
    assert.deepEqual(pricedModes, ['image-to-video', 'text-to-video']);
    assert.deepEqual(finalConfig.capabilities.slice().sort(), ['image-to-video', 'text-to-video']);
    for (const mode of pricedModes) assert.deepEqual(finalConfig.videoBillingConfiguration.modePrices[mode], { '720p': 8 });
    const visible = await studio('/ai/model/listModels');
    const modelOption = visible.models.find(item => item.label === modelName || item.value.endsWith('::' + modelName));
    assert.ok(modelOption, 'MiniMax H3 is not visible in the Studio model picker');
    assert.ok(visible.videoModels.includes(modelOption.value), 'MiniMax H3 is not listed as a video model');
    assert.ok(!visible.imageModels.includes(modelOption.value), 'MiniMax H3 was incorrectly listed as an image model');

    console.log(JSON.stringify({
        configured: true,
        channel: channelName,
        plugin: pluginKey,
        activeVersion: version,
        model: modelName,
        modelValue: modelOption.value,
        billingUnit: 'generation',
        creditsPerGeneration: 8,
        resolutions: ['720p'],
        supportedDurationsSeconds: durations,
        capabilities: ['text-to-video', 'image-to-video'],
        defaultsPreserved: true,
        adapterTests: { textToVideo: true, imageToVideo: true, queryPath: true, oneVideo: true },
    }));

} finally {
    await close();
}