/**
 * This file is licensed under the MIT License.
 *
 * Some code taken from https://github.com/actions/upload-release-asset
 */

import * as core from "@actions/core";
import { getOctokit } from '@actions/github';
// import type { GitHub } from '@actions/github/lib/utils';
import fs from "fs";
import { EnvHttpProxyAgent, fetch } from 'undici';

/**
 *
 * @param {InstanceType<typeof GitHub>} octokit
 * @param {*} name
 */
async function uploadAsset(octokit, name, timeout) {
	const url = core.getInput("upload_url", { required: true });
	const assetPath = core.getInput("asset_path", { required: true });
	const contentType = core.getInput("asset_content_type", { required: true });

	// Sent as a Blob rather than the raw Buffer. uploads.github.com can answer
	// with a 307/308, and undici re-sends the body on that hop; with a Buffer it
	// has already detached the backing ArrayBuffer and dies with "Cannot perform
	// ArrayBuffer.prototype.slice on a detached ArrayBuffer". A Blob is
	// re-readable, so the redirected request succeeds.
	const data = new Blob([fs.readFileSync(assetPath)], { type: contentType });

	// Do not set content-length here. fetch/undici derives it from the body it
	// actually sends, and a manual value is *appended* to that one rather than
	// replacing it, leaving undici to parseInt a joined "2464, 2464" string.
	const headers = { 'content-type': contentType };

	// Large release assets can take longer than undici's default five-minute
	// header timeout. Configure the upload transport itself, including proxies;
	// an Octokit request.timeout option does not change fetch's header timeout.
	const dispatcher = new EnvHttpProxyAgent({ headersTimeout: timeout });
	try {
		const uploadAssetResponse = await octokit.rest.repos.uploadReleaseAsset({
			url,
			headers,
			name,
			data,
			request: {
				fetch: (url, options) => fetch(url, { ...options, dispatcher }),
				signal: AbortSignal.timeout(timeout)
			}
		});
		return uploadAssetResponse.data.browser_download_url;
	} finally {
		await dispatcher.close();
	}
}

async function run() {
	try {
		// was the previous way before this was an action 'with' input
		const token_env = process.env.GITHUB_TOKEN || "";
		if (token_env != "")
			core.warning("This action no longer uses the GITHUB_TOKEN environment variable. You can simply remove the environment variable if it's `${secrets.GITHUB_TOKEN}` or migrate to setting `with: token: ...` instead. Setting this environment variable will be ignored in the future.");

		const token = token_env != "" ? token_env : core.getInput("token", { required: false });
		const sha = core.getInput("sha", { required: false });
		const owner_repo = core.getInput("repo", { required: false });
		const maxReleases = parseInt(core.getInput("max_releases", { required: false }));
		const ignoreHash = core.getBooleanInput("ignore_hash", { required: false });
		const releaseId = core.getInput("release_id", { required: true });
		const uploadTimeout = Number(core.getInput("upload_timeout") || "1800") * 1000;
		if (!Number.isSafeInteger(uploadTimeout) || uploadTimeout <= 0 || uploadTimeout > 2147483647)
			throw new Error("upload_timeout must be a positive number of seconds, at most 2147483.647");
		let name = core.getInput("asset_name", { required: true });
		const placeholderStart = name.indexOf("$$");
		const nameStart = name.substring(0, placeholderStart);
		const nameEnd = name.substring(placeholderStart + 2);

		const octokit = getOctokit(token);
		const hash = sha.substring(0, 7);
		const [owner, repo] = owner_repo.split('/');

		core.info("Checking previous assets");
		let assets = await octokit.rest.repos.listReleaseAssets({
			owner: owner,
			repo: repo,
			release_id: parseInt(releaseId),
			per_page: 100
		});

		assets.data.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

		/**
		 * @type {number[]}
		 */
		let toDelete = [];
		/**
		 * @type {number | undefined}
		 */
		let existingAssetNameId = undefined;

		let numFound = 0;
		for (let i = 0; i < assets.data.length; i++) {
			const asset = assets.data[i];
			if (asset.name == name) {
				// not commit hash or date in filename, always force upload here
				existingAssetNameId = asset.id;
			} else if (asset.name.startsWith(nameStart) && asset.name.endsWith(nameEnd)) {
				if (!ignoreHash && asset.name.endsWith("-" + hash + nameEnd)) {
					core.info("Current commit already released, exiting");
					core.setOutput("uploaded", "no");
					return;
				} else {
					numFound++;
					if (numFound >= maxReleases) {
						core.info("Queuing old asset " + asset.name + " for deletion");
						toDelete.push(asset.id);
					}
				}
			}
		}

		let now = new Date();
		let date = `${now.getUTCFullYear()}.${pad2(now.getUTCMonth()+1)}.${pad2(now.getUTCDate())}`;

		name = name.replace("$$", date + "-" + hash);

		if (existingAssetNameId !== undefined) {
			core.info("Deleting old asset of same name first");
			await octokit.rest.repos.deleteReleaseAsset({
				owner: owner,
				repo: repo,
				asset_id: existingAssetNameId
			});
		}

		core.info("Uploading asset as file " + name);
		let url = await uploadAsset(octokit, name, uploadTimeout);

		core.info("Deleting " + toDelete.length + " old assets");
		for (let i = 0; i < toDelete.length; i++) {
			const id = toDelete[i];
			await octokit.rest.repos.deleteReleaseAsset({
				owner: owner,
				repo: repo,
				asset_id: id
			});
		}

		core.setOutput("uploaded", "yes");
		core.setOutput("url", url);
		core.setOutput("asset_name", name);
	} catch (error) {
		if (error.stack)
			core.debug(error.stack);
		if (error.cause)
			core.debug("caused by: " + (error.cause.stack || error.cause.message));
		core.setFailed(error.message);
	}
}

function pad2(v) {
	v = v.toString();
	while (v.length < 2) v = "0" + v;
	return v;
}

run();
