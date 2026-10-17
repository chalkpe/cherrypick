/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { compareVersions, validate } from 'compare-versions';
import { version } from '@@/js/config.js';
import { misskeyApi } from '@/utility/misskey-api.js';

export const openCommitPage = (repo: string, hash: string) => {
	if (hash && hash !== 'unknown') {
		window.open(`https://github.com/${repo}/commit/${hash}`, '_blank');
	}
};

export const cherryPickRepository = 'chalkpe/cherrypick';

export type GitHubRelease = {
	tag_name: string;
	prerelease: boolean;
	published_at: string;
	html_url: string;
};

// CherryPick revisions are encoded as build metadata, which semver normally ignores.
export function compareCherryPickVersions(a: string, b: string): number {
	const baseComparison = compareVersions(a, b);
	if (baseComparison !== 0) return baseComparison;
	const revision = (value: string) => Number(value.match(/\+choco\.(\d+)(?:\.|$)/)?.[1] ?? 0);
	return Math.sign(revision(a) - revision(b));
}

export async function fetchReleases(repo: string): Promise<GitHubRelease[]> {
	const response = await window.fetch(`https://api.github.com/repos/${repo}/releases`);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const data: unknown = await response.json();
	if (!Array.isArray(data)) throw new Error('Invalid GitHub releases response');
	return data.filter((release): release is GitHubRelease =>
		release != null && typeof release.tag_name === 'string' && validate(release.tag_name) &&
		typeof release.prerelease === 'boolean' && typeof release.published_at === 'string' &&
		typeof release.html_url === 'string',
	);
}

export function getLatestRelease(releases: GitHubRelease[], includePrerelease: boolean): GitHubRelease | undefined {
	return releases
		.filter(release => includePrerelease || !release.prerelease)
		.sort((a, b) => compareCherryPickVersions(b.tag_name, a.tag_name))[0];
}

export async function fetchCherrypickReleases(): Promise<boolean> {
	try {
		const meta = await misskeyApi('admin/meta');
		const latestRelease = getLatestRelease(await fetchReleases(cherryPickRepository), meta.enableReceivePrerelease);
		if (!latestRelease) return false;
		const skippedVersion = meta.skipCherryPickVersion;
		return compareCherryPickVersions(version, latestRelease.tag_name) < 0 &&
			(!skippedVersion || !validate(skippedVersion) || compareCherryPickVersions(skippedVersion, latestRelease.tag_name) < 0);
	} catch (error) {
		console.error('Failed to fetch CherryPick releases:', error);
		return false;
	}
}

export async function getCommitHashForRelease(repo: string, release: GitHubRelease): Promise<string> {
	try {
		const response = await window.fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(release.tag_name)}`);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const commitData = await response.json();
		return commitData.sha || 'unknown';
	} catch (error) {
		console.error(`Failed to fetch commit hash for ${release.tag_name}:`, error);
		return 'unknown';
	}
}
