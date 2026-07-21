import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import test from 'node:test';
import YAML from 'yaml';

const require = createRequire(import.meta.url);
const { executeAppBuilderAsJson } = require('app-builder-lib/out/util/appBuilder');
const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');

function sha512(buffer, encoding) {
  return createHash('sha512').update(buffer).digest(encoding);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('public update verifier accepts matching channels and rejects managed HTML', async () => {
  const version = '9.9.9';
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'uclaw-update-channel-'));
  const installerName = `UClaw-${version}-win-x64.exe`;
  const macName = `UClaw-${version}-mac-arm64.zip`;
  const linuxName = `UClaw-${version}-linux-x86_64.AppImage`;
  const portableName = `UClaw-${version}-win-x64-usb.zip`;
  const installer = Buffer.from('signed-installer-fixture');
  const mac = Buffer.from('signed-mac-fixture');
  const linux = Buffer.from('signed-linux-fixture');
  const portable = Buffer.from('portable-zip-fixture');
  const installerSha512 = sha512(installer, 'base64');
  const macSha512 = sha512(mac, 'base64');
  const linuxSha512 = sha512(linux, 'base64');
  const portableSha512 = sha512(portable, 'hex');
  const installerManifest = {
    version,
    files: [{
      url: installerName,
      sha512: installerSha512,
      size: installer.length,
    }],
    path: installerName,
    sha512: installerSha512,
    releaseDate: new Date(0).toISOString(),
  };
  const portableMetadata = {
    version,
    platform: 'win',
    arch: 'x64',
    packageType: 'portable_zip',
    package_type: 'portable_zip',
    fileName: portableName,
    file_name: portableName,
    size: portable.length,
    sha512: portableSha512,
  };
  const macManifest = {
    version,
    files: [{ url: macName, sha512: macSha512, size: mac.length }],
    path: macName,
    sha512: macSha512,
  };
  const linuxManifest = {
    version,
    files: [{ url: linuxName, sha512: linuxSha512, size: linux.length }],
    path: linuxName,
    sha512: linuxSha512,
  };
  const manifestPath = path.join(fixtureRoot, 'latest.yml');
  const installerPath = path.join(fixtureRoot, installerName);
  const blockmapPath = `${installerPath}.blockmap`;
  const macManifestPath = path.join(fixtureRoot, 'latest-mac.yml');
  const linuxManifestPath = path.join(fixtureRoot, 'latest-linux.yml');
  const metadataPath = path.join(fixtureRoot, portableName.replace(/\.zip$/u, '.json'));
  await Promise.all([
    writeFile(installerPath, installer),
    writeFile(manifestPath, YAML.stringify(installerManifest)),
    writeFile(path.join(fixtureRoot, macName), mac),
    writeFile(macManifestPath, YAML.stringify(macManifest)),
    writeFile(path.join(fixtureRoot, linuxName), linux),
    writeFile(linuxManifestPath, YAML.stringify(linuxManifest)),
    writeFile(path.join(fixtureRoot, portableName), portable),
    writeFile(metadataPath, JSON.stringify(portableMetadata)),
  ]);
  await executeAppBuilderAsJson([
    'blockmap',
    '--input',
    installerPath,
    '--output',
    blockmapPath,
  ]);
  const validBlockmap = await readFile(blockmapPath);

  let managedReturnsHtml = false;
  let legacyAvailable = true;
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/api/clawx/updates/feed/latest/latest.yml') {
      response.setHeader('content-type', managedReturnsHtml ? 'text/html' : 'application/yaml');
      response.end(managedReturnsHtml ? '<!doctype html><title>admin</title>' : YAML.stringify(installerManifest));
      return;
    }
    if (requestUrl.pathname === '/api/clawx/updates/feed/latest/latest-mac.yml') {
      response.setHeader('content-type', 'application/yaml');
      response.end(YAML.stringify(macManifest));
      return;
    }
    if (requestUrl.pathname === '/api/clawx/updates/feed/latest/latest-linux.yml') {
      response.setHeader('content-type', 'application/yaml');
      response.end(YAML.stringify(linuxManifest));
      return;
    }
    if (requestUrl.pathname.startsWith('/legacy/latest')) {
      if (!legacyAvailable) {
        response.statusCode = 503;
        response.end('legacy unavailable');
        return;
      }
      response.setHeader('content-type', 'application/yaml');
      response.end(YAML.stringify(
        requestUrl.pathname.endsWith('-mac.yml')
          ? macManifest
          : requestUrl.pathname.endsWith('-linux.yml')
            ? linuxManifest
            : installerManifest,
      ));
      return;
    }
    if (requestUrl.pathname === '/api/clawx/updates/latest') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        data: {
          ...portableMetadata,
          downloadUrl: `http://127.0.0.1/files/${portableName}`,
        },
      }));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });

  try {
    const origin = await listen(server);
    const env = {
      ...process.env,
      UCLAW_UPDATE_VERIFY_ORIGIN: origin,
      UCLAW_UPDATE_VERIFY_LEGACY_FEED: `${origin}/legacy/latest.yml`,
    };
    const args = [
      path.join(ROOT, 'scripts', 'verify-public-update-channel.mjs'),
      '--version',
      version,
      '--installer-manifest',
      manifestPath,
      '--portable-metadata',
      metadataPath,
      '--mac-manifest',
      macManifestPath,
      '--linux-manifest',
      linuxManifestPath,
    ];
    const passed = await execFileAsync(process.execPath, args, { cwd: ROOT, env });
    assert.match(passed.stdout, /"status": "passed"/u);

    legacyAvailable = false;
    const managedOnly = await execFileAsync(process.execPath, [...args, '--managed-only'], { cwd: ROOT, env });
    assert.match(managedOnly.stdout, /"managedOnly": true/u);

    legacyAvailable = true;
    const staleBlockmap = JSON.parse(gunzipSync(validBlockmap).toString('utf8'));
    staleBlockmap.files[0].checksums[0] = 'stale-signed-installer-block';
    await writeFile(blockmapPath, gzipSync(JSON.stringify(staleBlockmap)));
    await assert.rejects(
      execFileAsync(process.execPath, args, { cwd: ROOT, env }),
      (error) => {
        assert.match(String(error.stderr), /blockmap does not match the installer/u);
        return true;
      },
    );
    await writeFile(blockmapPath, validBlockmap);

    legacyAvailable = true;
    managedReturnsHtml = true;
    await assert.rejects(
      execFileAsync(process.execPath, args, { cwd: ROOT, env }),
      (error) => {
        assert.match(String(error.stderr), /managed installer feed returned HTML/u);
        return true;
      },
    );
  } finally {
    if (server.listening) await close(server);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
