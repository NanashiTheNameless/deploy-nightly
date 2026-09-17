import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

async function runAction(t, { redirect, delay = 0, timeout = '1800' } = {}) {
    const requests = [];
    const timers = [];
    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        requests.push({ method: req.method, url: req.url, headers: req.headers,
            body: Buffer.concat(chunks) });
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET') {
            res.end('[]');
        } else if (redirect && req.url.startsWith('/uploads')) {
            res.writeHead(redirect, { location: '/redirected' });
            res.end();
        } else {
            timers.push(setTimeout(() => {
                res.writeHead(201);
                res.end(JSON.stringify({ browser_download_url: 'https://example.com/asset' }));
            }, delay));
        }
    });
    t.after(() => {
        timers.forEach(clearTimeout);
        server.closeAllConnections();
        server.close();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env,
        GITHUB_API_URL: base,
        GITHUB_TOKEN: '',
        GITHUB_OUTPUT: '',
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*',
        http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '*',
        INPUT_TOKEN: 'test-token',
        INPUT_REPO: 'owner/repo',
        INPUT_SHA: '1234567890',
        INPUT_RELEASE_ID: '1',
        INPUT_UPLOAD_URL: `${base}/uploads{?name,label}`,
        INPUT_ASSET_PATH: `${root}/README.md`,
        INPUT_ASSET_NAME: 'test asset.md',
        INPUT_ASSET_CONTENT_TYPE: 'text/plain',
        INPUT_MAX_RELEASES: '1',
        INPUT_IGNORE_HASH: 'false',
        INPUT_UPLOAD_TIMEOUT: timeout
    };
    const child = spawn(process.execPath, ['index.js'], { cwd: root, env });
    t.after(() => child.kill());
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const [code] = await once(child, 'close');
    return { code, output, requests };
}

for (const redirect of [undefined, 307, 308]) {
    test(`uploads a replayable body with redirect ${redirect ?? 'none'}`, { timeout: 10000 }, async t => {
        const { code, output, requests } = await runAction(t, { redirect, delay: 150 });
        assert.equal(code, 0, output);
        assert.match(output, /::set-output name=uploaded::yes/);
        assert.match(output, /::set-output name=url::https:\/\/example.com\/asset/);
        const uploads = requests.filter(req => req.method === 'POST');
        assert.equal(uploads.length, redirect ? 2 : 1);
        const data = await readFile(`${root}/README.md`);
        for (const upload of uploads) {
            assert.deepEqual(upload.body, data);
            assert.equal(upload.headers['content-length'], String(data.length));
            assert.equal(upload.headers['content-type'], 'text/plain');
        }
        assert.equal(new URL(uploads[0].url, 'https://example.com').searchParams.get('name'), 'test asset.md');
    });
}

test('bounds a stalled upload and reports failure without success outputs', { timeout: 10000 }, async t => {
    const { code, output, requests } = await runAction(t, { delay: 2000, timeout: '0.1' });
    assert.equal(code, 1, output);
    assert.match(output, /::error::.*(?:timeout|timed out)/i);
    assert.doesNotMatch(output, /::set-output name=uploaded::yes/);
    assert.equal(requests.filter(req => req.method === 'POST').length, 1);
});

for (const timeout of ['0', '-1', 'invalid', 'Infinity', '2147484']) {
    test(`rejects invalid timeout ${timeout} before accessing release assets`, { timeout: 10000 }, async t => {
        const { code, output, requests } = await runAction(t, { timeout });
        assert.equal(code, 1, output);
        assert.match(output, /upload_timeout must be a positive number/);
        assert.equal(requests.length, 0);
    });
}
