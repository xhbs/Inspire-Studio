import assert from 'node:assert/strict';
import { localClients } from './lib/newapi-local.mjs';

const imageModels = ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];
const videoModels = ['wan-3.0'];
const imageKey = process.env.AIXORAS_IMAGE_API_KEY;
const videoKey = process.env.AIXORAS_VIDEO_API_KEY;
const imageBaseUrl = 'https://api.aixoras.com/v1';
const videoBaseUrl = 'https://api.aixoras.com';
const videoPluginKey = 'studio-aixoras-video';
const normalizeBaseUrl = value => value.replace(/\/+$/, '').replace(/\/v1$/i, '');

assert.ok(imageKey, 'Set AIXORAS_IMAGE_API_KEY for this process');
assert.ok(videoKey, 'Set AIXORAS_VIDEO_API_KEY for this process');

const { studio, close } = await localClients();
try {
    const imageCatalog = await studio('/admin/newapi/channels/models', {
        type: 1, baseUrl: imageBaseUrl, apiKey: imageKey,
    });
    const missingImages = imageModels.filter(model => !imageCatalog.includes(model));
    assert.deepEqual(missingImages, [], 'Aixoras image credential does not expose all requested models');

    const videoCatalog = await studio('/admin/newapi/channels/models', { type: 61, pluginKey: videoPluginKey });
    assert.ok(videoModels.every(model => videoCatalog.includes(model)), 'Aixoras video plugin does not advertise wan-3.0');

    const before = (await studio('/config/model/listModelConfigs')).modelConfigs;
    const defaults = before.filter(model => model.defaultModel).map(model => model.id).sort();
    const configuredDefaultTypes = new Set(before.filter(model => model.defaultModel).map(model => model.modelType));

    const channels = await studio('/admin/newapi/channels?page=1&pageSize=100&keyword=Aixoras');
    const saveChannel = async (name, type, baseUrl, apiKey, models, pluginKey = null) => {
        const existing = channels.items.filter(channel => channel.name === name);
        assert.ok(existing.length <= 1, `Multiple NewAPI channels named ${name} already exist`);
        const current = existing[0];
        if (current) {
            assert.equal(current.type, type, `Refusing to change the existing ${name} channel type`);
            assert.equal(normalizeBaseUrl(current.baseUrl), normalizeBaseUrl(baseUrl),
                `Refusing to change the existing ${name} channel Base URL`);
        }
        await studio('/admin/newapi/channels/save', {
            id: current?.id,
            name,
            type,
            baseUrl,
            apiKey,
            models,
            priority: current?.priority ?? 0,
            weight: current?.weight ?? 1,
            modelMapping: '{}',
            ...(pluginKey ? { pluginKey } : {}),
        });
        return current ? { id: current.id, created: false } : { id: null, created: true };
    };

    const imageChannel = await saveChannel('Aixoras Image Group', 1, imageBaseUrl, imageKey, imageModels);
    const videoChannel = await saveChannel('Aixoras Video Group (wan-3.0)', 61, videoBaseUrl, videoKey, videoModels, videoPluginKey);

    const imageSync = await studio('/admin/newapi/models/sync', {
        models: imageModels, modelType: 'image', capabilities: ['text-to-image', 'image-to-image'],
        creditCost: 10, setDefault: false,
    });
    const videoSync = await studio('/admin/newapi/models/sync', {
        models: videoModels, modelType: 'video', capabilities: ['text-to-video', 'image-to-video'],
        creditCost: 10, resolutions: ['720P'], setDefault: false,
    });

    // Studio only exposes a model category after it has one default model configured.
    if (!configuredDefaultTypes.has('image')) {
        await studio('/admin/newapi/models/sync', {
            models: ['gpt-image-2'], modelType: 'image', capabilities: ['text-to-image', 'image-to-image'],
            creditCost: 10, setDefault: true,
        });
    }
    if (!configuredDefaultTypes.has('video')) {
        await studio('/admin/newapi/models/sync', {
            models: ['wan-3.0'], modelType: 'video', capabilities: ['text-to-video', 'image-to-video'],
            creditCost: 10, resolutions: ['720P'], setDefault: true,
        });
    }

    const after = (await studio('/config/model/listModelConfigs')).modelConfigs;
    const expectedDefaults = [...defaults];
    if (!configuredDefaultTypes.has('image')) expectedDefaults.push(after.find(model => model.modelName === 'gpt-image-2' && model.modelType === 'image').id);
    if (!configuredDefaultTypes.has('video')) expectedDefaults.push(after.find(model => model.modelName === 'wan-3.0' && model.modelType === 'video').id);
    assert.deepEqual(after.filter(model => model.defaultModel).map(model => model.id).sort(), expectedDefaults.sort(),
        'Aixoras setup must preserve existing defaults and only fill missing model categories');
    for (const model of imageModels) assert.ok(after.some(item => item.modelName === model && item.modelType === 'image'));
    for (const model of videoModels) assert.ok(after.some(item => item.modelName === model && item.modelType === 'video'));

    const visible = await studio('/ai/model/listModels');
    for (const model of imageModels) {
        const value = 'studio-newapi-image::' + model;
        assert.ok(visible.imageModels.includes(value), `Image model is not visible in Studio: ${model}`);
        assert.ok(!visible.videoModels.includes(value), `Image model leaked into the video list: ${model}`);
    }
    for (const model of videoModels) {
        const value = 'studio-newapi-video::' + model;
        assert.ok(visible.videoModels.includes(value), `Video model is not visible in Studio: ${model}`);
        assert.ok(!visible.imageModels.includes(value), `Video model leaked into the image list: ${model}`);
    }

    console.log(JSON.stringify({
        imageChannel, videoChannel, imageModels, videoModels, imageSync, videoSync,
        defaultsPreserved: true, generatedMediaTested: false,
    }));
} finally {
    await close();
}
