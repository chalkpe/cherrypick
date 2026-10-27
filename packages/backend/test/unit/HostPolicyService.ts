/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { FindOperator } from 'typeorm';
import { HostPolicyService } from '@/core/HostPolicyService.js';
import { UtilityService } from '@/core/UtilityService.js';
import type { InstancesRepository } from '@/models/_.js';
import type { MiMeta } from '@/models/Meta.js';

type InstanceRow = { host: string; suspensionState: string; quarantineLimited?: boolean };

function createFixture(metaOverrides: Partial<Pick<MiMeta, 'federation' | 'federationHosts' | 'blockedHosts'>> = {}, instances: InstanceRow[] = []) {
	const meta = { federation: 'all', federationHosts: [], blockedHosts: [], ...metaOverrides } as Pick<MiMeta, 'federation' | 'federationHosts' | 'blockedHosts'>;
	// 実物を使い、連合の判定と記録を引く host の正規化 (toPuny はポート付きのホストに '' を返す) もそのまま確かめる
	const utilityService = new UtilityService({ host: 'local.test', url: 'https://local.test' } as ConstructorParameters<typeof UtilityService>[0], meta as MiMeta);
	// instance.host は保存されたとおりの文字列で引かれる (where の host は In)
	const instancesRepository = {
		findBy: vi.fn(async ({ host }: { host: FindOperator<string[]> }) => instances.filter(instance => (host.value as unknown as string[]).includes(instance.host))),
	};
	const logger = { warn: vi.fn() };
	const service = new HostPolicyService(meta as MiMeta, instancesRepository as unknown as InstancesRepository, utilityService, { getLogger: () => logger } as any);
	return { service, meta, instancesRepository, logger };
}

describe('HostPolicyService', () => {
	test('decides many hosts with one query of the server records', async () => {
		const f = createFixture({}, [
			{ host: 'suspended.test', suspensionState: 'manuallySuspended' },
			{ host: 'quarantined.test', suspensionState: 'none', quarantineLimited: true },
			{ host: 'fine.test', suspensionState: 'none' },
		]);

		const refused = await f.service.refusedRemoteHostsOf(['suspended.test', 'quarantined.test', 'fine.test', 'unknown.test', 'fine.test']);

		expect(Object.fromEntries(refused)).toEqual({
			'suspended.test': true,
			'quarantined.test': true,
			'fine.test': false,
			'unknown.test': false,
		});
		expect(f.instancesRepository.findBy).toHaveBeenCalledTimes(1);
	});

	test('refuses hosts the settings refuse, and hosts it cannot read, without reading their records', async () => {
		const f = createFixture({ blockedHosts: ['blocked.test'] });

		const refused = await f.service.refusedRemoteHostsOf(['blocked.test:8443', 'sub.blocked.test', 'not a host', '']);

		expect(Object.fromEntries(refused)).toEqual({
			'blocked.test:8443': true,
			'sub.blocked.test': true,
			'not a host': true,
			'': true,
		});
		expect(f.instancesRepository.findBy).not.toHaveBeenCalled();
	});

	test('reads no records for no hosts', async () => {
		const f = createFixture();

		expect((await f.service.refusedRemoteHostsOf([])).size).toBe(0);
		expect(f.instancesRepository.findBy).not.toHaveBeenCalled();
	});

	// inbox (InboxProcessorService) と同じく、連合を許すかは正規化したホストだけで決める
	test.each([
		['a port', 'remote.test:8443', false],
		['a trailing dot', 'remote.test.', false],
		['upper case', 'REMOTE.test', false],
		['a subdomain', 'sub.remote.test', false],
		['another domain', 'other.test', true],
		['a lookalike domain', 'notremote.test', true],
	])('decides specified federation for a host with %s on the normalized host', async (_label, host, expected) => {
		const f = createFixture({ federation: 'specified', federationHosts: ['remote.test'] });

		expect(await f.service.isRefusedRemoteHost(host)).toBe(expected);
	});

	test('refuses every remote host when federation is off', async () => {
		const f = createFixture({ federation: 'none' });

		expect(await f.service.isRefusedRemoteHost('remote.test')).toBe(true);
	});

	// 停止は fetch() と同じく toPuny した記録 (ポート付きのホストはすべて '') にも従い、隔離は inbox と同じくそのサーバーの記録だけで決める
	test.each([
		['suspension', { suspensionState: 'manuallySuspended' }, true],
		['quarantine', { suspensionState: 'none', quarantineLimited: true }, false],
	])('follows the %s of the record shared by hosts with a port as fetch() and the inbox do', async (_label, row, expected) => {
		const f = createFixture({}, [{ host: '', ...row }]);

		expect(await f.service.isRefusedRemoteHost('evil.example:8443')).toBe(expected);
		expect(await f.service.isRefusedRemoteHost('evil.example')).toBe(false);
	});

	// 一度に読めなければホストごとに読み直し、読めたホストだけ決める。一つのホストが読めなくても、ほかのホストは決める
	test('decides each host it can read when reading them all at once fails', async () => {
		const f = createFixture({ blockedHosts: ['blocked.test'] }, [{ host: 'suspended.test', suspensionState: 'manuallySuspended' }]);
		const findBy = f.instancesRepository.findBy.getMockImplementation()!;
		f.instancesRepository.findBy.mockImplementation(async (where: { host: FindOperator<string[]> }) => {
			if ((where.host.value as unknown as string[]).some(host => host.startsWith('broken.test'))) throw new Error('db is down');
			return await findBy(where);
		});

		const decided = await f.service.refusedRemoteHostsOrUnknown(['suspended.test', 'fine.test', 'broken.test', 'blocked.test']);

		expect(Object.fromEntries(decided)).toEqual({
			'suspended.test': true,
			'fine.test': false,
			'broken.test': null,
			'blocked.test': true,
		});
	});

	test('logs the original batch and per-host failure causes without adding their contents to messages', async () => {
		const f = createFixture();
		const batchError = new Error('batch unavailable');
		const hostError = new Error('single unavailable');
		f.instancesRepository.findBy.mockRejectedValueOnce(batchError).mockRejectedValue(hostError);
		expect(await f.service.refusedRemoteHostsOrUnknown(['broken.test'])).toEqual(new Map([['broken.test', null]]));
		expect(f.logger.warn.mock.calls).toEqual([
			['Failed to read the remote host policies together; retrying each host', { error: batchError }],
			['Failed to read a remote host policy', { error: hostError }],
		]);
	});

	test('reads the records as they are now', async () => {
		const rows: InstanceRow[] = [{ host: 'remote.test', suspensionState: 'none' }];
		const f = createFixture({}, rows);
		expect(await f.service.isRefusedRemoteHost('remote.test')).toBe(false);

		rows[0].suspensionState = 'goneSuspended';

		expect(await f.service.isRefusedRemoteHost('remote.test')).toBe(true);
	});
});
