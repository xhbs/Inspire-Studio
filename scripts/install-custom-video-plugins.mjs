import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { localClients } from './lib/newapi-local.mjs';
import { meta as aixorasMeta } from '../newapi/plugins/aixoras-video.mjs';
import { meta as chengmengMeta } from '../newapi/plugins/chengmeng-video.mjs';

const plugins = [
    { meta: aixorasMeta, file: '../newapi/plugins/aixoras-video.mjs', remark: 'Aixoras wan-3.0 async video protocol' },
    { meta: chengmengMeta, file: '../newapi/plugins/chengmeng-video.mjs', remark: 'Chengmeng async video task protocol' },
];

const { admin, close } = await localClients();
try {
    await mkdir(new URL('../newapi/generated/', import.meta.url), { recursive: true });
    for (const plugin of plugins) {
        const template = await readFile(new URL(plugin.file, import.meta.url), 'utf8');
        const version = '1.0.0+' + createHash('sha256').update(template).digest('hex').slice(0, 12);
        const source = template.replace(/version:\s*'1\.0\.0'/, `version: '${version}'`);
        assert.notEqual(source, template, `Unable to stamp plugin version for ${plugin.meta.key}`);

        await writeFile(new URL(`../newapi/generated/${plugin.meta.key}.js`, import.meta.url), source);
        await admin('/api/plugin/task', { source, enabled: true, remark: plugin.remark });
        await admin('/api/plugin/task/' + plugin.meta.key + '/activate', { version });
        const active = await admin('/api/plugin/task/' + plugin.meta.key);
        assert.equal(active.plugin.version, version, `Plugin activation failed: ${plugin.meta.key}`);
        console.log(JSON.stringify({ plugin: plugin.meta.key, models: plugin.meta.models, version, active: true }));
    }
} finally {
    await close();
}
