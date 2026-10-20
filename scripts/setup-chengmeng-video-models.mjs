import assert from 'node:assert/strict';
import { localClients } from './lib/newapi-local.mjs';

const apiKey = process.env.CHENGMENG_API_KEY;
const baseUrl = 'https://api.chengmeng.site';
const channelName = 'Chengmeng Video Group';
const pluginKey = 'studio-chengmeng-video';
const modelNames = ['sd-2.5-lw-按次', 'sd-2.0-按次'];
const capabilities = ['text-to-video', 'image-to-video'];

assert.ok(apiKey, 'Set CHENGMENG_API_KEY for this process');

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function modelName(row) { return String(row.name ?? row.model_name ?? row.model ?? '').trim(); }
function modelId(row) { return Number(row.id ?? row.model_id); }

async function loadAccountModels() {
    let response;
    try {
        response = await fetch(baseUrl + '/api/models', {
            headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
            signal: AbortSignal.timeout(30000),
        });
    } catch {
        throw new Error('Unable to reach Chengmeng model catalog; no channel changes were made');
    }
    if (!response.ok) throw new Error('Chengmeng model catalog request failed with HTTP ' + response.status + '; no channel changes were made');
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error('Chengmeng model catalog returned invalid JSON; no channel changes were made'); }
    if (payload?.code !== undefined && String(payload.code) !== '0') {
        throw new Error('Chengmeng rejected the model catalog request; no channel changes were made');
    }

    const rows = [];
    const visit = (value, depth = 0) => {
        if (depth > 8 || value == null) return;
        if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
        if (!isObject(value)) return;
        if (modelName(value)) rows.push(value);
        for (const child of Object.values(value)) if (typeof child === 'object') visit(child, depth + 1);
    };
    visit(payload);

    const resolved = {};
    for (const name of modelNames) {
        const matches = rows.filter(row => modelName(row) === name);
        assert.equal(matches.length, 1, `Expected one account model row for ${name}; no channel changes were made`);
        const row = matches[0];
        const id = modelId(row);
        assert.ok(Number.isSafeInteger(id) && id > 0, `Chengmeng did not provide a numeric ID for ${name}; no channel changes were made`);
        const type = String(row.model_type ?? row.type ?? '').trim().toLowerCase();
        assert.ok(!type || type === 'video', `${name} is not marked as a video model; no channel changes were made`);
        resolved[name] = String(id);
    }
    return resolved;
}

const modelMapping = await loadAccountModels();
const { studio, close } = await localClients();
try {
    const pluginModels = await studio('/admin/newapi/channels/models', { type: 61, pluginKey });
    assert.ok(modelNames.every(name => pluginModels.includes(name)), 'Chengmeng video plugin is not installed');

    const page = await studio('/admin/newapi/channels?page=1&pageSize=100&keyword=Chengmeng');
    const matches = page.items.filter(channel => channel.name === channelName);
    assert.ok(matches.length <= 1, 'Multiple Chengmeng video channels already exist');
    const current = matches[0];
    if (current) {
        assert.equal(current.type, 61, 'Refusing to change the existing Chengmeng channel type');
        assert.equal(current.baseUrl.replace(/\/+$/, ''), baseUrl, 'Refusing to change the existing Chengmeng Base URL');
    }

    await studio('/admin/newapi/channels/save', {
        id: current?.id,
        name: channelName,
        type: 61,
        baseUrl,
        apiKey,
        models: modelNames,
        priority: current?.priority ?? 0,
        weight: current?.weight ?? 1,
        modelMapping: JSON.stringify(modelMapping),
        pluginKey,
    });

    const before = (await studio('/config/model/listModelConfigs')).modelConfigs;
    const defaults = before.filter(model => model.defaultModel).map(model => model.id).sort();
    await studio('/admin/newapi/models/sync', {
        models: modelNames, modelType: 'video', capabilities,
        creditCost: 10, resolutions: ['720P'], setDefault: false,
    });

    const created = (await studio('/config/model/listModelConfigs')).modelConfigs;
    for (const name of modelNames) {
        const config = created.find(model => model.modelName === name && model.modelType === 'video');
        assert.ok(config, `Studio video model was not created: ${name}`);
        const previous = config.videoBillingConfiguration || {};
        const videoBillingConfiguration = {
            ...previous,
            billingUnit: 'generation',
            minimumDurationSeconds: previous.minimumDurationSeconds || 1,
            defaultResolution: previous.defaultResolution || '720p',
            modePrices: Object.fromEntries(capabilities.map(mode => [mode, { '720p': 10 }])),
        };
        await studio('/config/model/updateModelConfig', { ...config, videoBillingConfiguration });
    }

    const after = (await studio('/config/model/listModelConfigs')).modelConfigs;
    assert.deepEqual(after.filter(model => model.defaultModel).map(model => model.id).sort(), defaults,
        'Chengmeng setup must preserve existing default models');
    const visible = await studio('/ai/model/listModels');
    for (const name of modelNames) {
        const value = 'studio-newapi-video::' + name;
        assert.ok(visible.videoModels.includes(value), `Chengmeng video model is not visible: ${name}`);
        assert.ok(!visible.imageModels.includes(value), `Video model leaked into the image list: ${name}`);
    }

    console.log(JSON.stringify({ channel: channelName, plugin: pluginKey, modelIds: modelMapping,
        modelType: 'video', billingUnit: 'generation', defaultsPreserved: true, generatedMediaTested: false }));
} finally {
    await close();
}
