/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { compareCherryPickVersions, fetchCherrypickReleases, fetchReleases, getLatestRelease } from '@/utility/fetch-releases.js';
import { misskeyApi } from '@/utility/misskey-api.js';

vi.mock('@@/js/config.js', () => ({ version: '2026.10.0+choco.1' }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));

describe('CherryPick update notifications', () => {
	afterEach(() => {
		fetchMock.resetMocks();
		vi.restoreAllMocks();
	});

	test('detects a newer choco revision from the maintained repository', async () => {
		vi.mocked(misskeyApi).mockResolvedValue({ enableReceivePrerelease: false, skipCherryPickVersion: null } as never);
		fetchMock.mockIf('https://api.github.com/repos/chalkpe/cherrypick/releases', JSON.stringify([
			{ tag_name: '2026.10.0+choco.2', prerelease: false, published_at: '2026-10-10T00:00:00Z', html_url: 'https://github.com/chalkpe/cherrypick/releases/tag/2026.10.0%2Bchoco.2' },
		]));
		expect(await fetchCherrypickReleases()).toBe(true);
	});
});

describe('CherryPick release selection', () => {
	const releases = [
		{ tag_name: '2026.10.0+choco.2', prerelease: false, published_at: '2026-10-10T00:00:00Z', html_url: 'https://github.com/chalkpe/cherrypick/releases/tag/2026.10.0%2Bchoco.2' },
		{ tag_name: '2026.11.0-beta.1+choco.1', prerelease: true, published_at: '2026-10-10T00:00:00Z', html_url: 'https://github.com/chalkpe/cherrypick/releases/tag/2026.11.0-beta.1%2Bchoco.1' },
		{ tag_name: '2026.10.0+choco.1', prerelease: false, published_at: '2026-10-10T00:00:00Z', html_url: 'https://github.com/chalkpe/cherrypick/releases/tag/2026.10.0%2Bchoco.1' },
	];

	test.each([
		['2026.10.0+choco.1', '2026.10.0+choco.2', -1],
		['2026.10.0+choco.10', '2026.10.0+choco.2', 1],
		['2026.10.0+choco.1', '2026.10.0+choco.1', 0],
		['4.17.0', '2026.10.0+choco.1', -1],
		['2026.11.0+choco.1', '2026.10.0+choco.10', 1],
		['2026.10.0-beta.1+choco.2', '2026.10.0+choco.1', -1],
	])('compares %s with %s', (a, b, expected) => {
		expect(Math.sign(compareCherryPickVersions(a, b))).toBe(expected);
	});

	test('selects the newest eligible version regardless of API order', () => {
		expect(getLatestRelease(releases, false)?.tag_name).toBe('2026.10.0+choco.2');
		expect(getLatestRelease(releases, true)?.tag_name).toBe('2026.11.0-beta.1+choco.1');
		expect(releases[0].tag_name).toBe('2026.10.0+choco.2');
	});

	test('handles no eligible releases', () => {
		expect(getLatestRelease([], false)).toBeUndefined();
		expect(getLatestRelease([releases[1]], false)).toBeUndefined();
	});

	test.each(['2026.10.0+choco.2', '4.17.0', 'invalid'])('honors skipped version %s without suppressing future versions', async skipped => {
		vi.mocked(misskeyApi).mockResolvedValue({ enableReceivePrerelease: false, skipCherryPickVersion: skipped } as never);
		fetchMock.mockResponseOnce(JSON.stringify(releases));
		expect(await fetchCherrypickReleases()).toBe(skipped !== '2026.10.0+choco.2');
	});

	test('rejects GitHub API errors', async () => {
		fetchMock.mockResponseOnce(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403 });
		await expect(fetchReleases('chalkpe/cherrypick')).rejects.toThrow('HTTP 403');
	});

	test('ignores invalid release tags', async () => {
		fetchMock.mockResponseOnce(JSON.stringify([{ ...releases[0], tag_name: 'not-a-version' }, ...releases]));
		expect(await fetchReleases('chalkpe/cherrypick')).toEqual(releases);
	});

	test('does not notify when already on the latest revision', async () => {
		vi.mocked(misskeyApi).mockResolvedValue({ enableReceivePrerelease: false, skipCherryPickVersion: null } as never);
		fetchMock.mockResponseOnce(JSON.stringify([releases[2]]));
		expect(await fetchCherrypickReleases()).toBe(false);
	});

	test('does not notify when only excluded prereleases exist', async () => {
		vi.mocked(misskeyApi).mockResolvedValue({ enableReceivePrerelease: false, skipCherryPickVersion: null } as never);
		fetchMock.mockResponseOnce(JSON.stringify([releases[1]]));
		expect(await fetchCherrypickReleases()).toBe(false);
	});

	test('does not notify on API failure', async () => {
		vi.mocked(misskeyApi).mockResolvedValue({ enableReceivePrerelease: false, skipCherryPickVersion: null } as never);
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		fetchMock.mockResponseOnce('{}', { status: 403 });
		expect(await fetchCherrypickReleases()).toBe(false);
		errorLog.mockRestore();
	});

	test('rejects a non-array API response', async () => {
		fetchMock.mockResponseOnce('{}');
		await expect(fetchReleases('chalkpe/cherrypick')).rejects.toThrow('Invalid GitHub releases response');
	});

	afterEach(() => fetchMock.resetMocks());
});
