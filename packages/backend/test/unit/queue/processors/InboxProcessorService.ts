/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { URL, domainToASCII } from 'node:url';
import type { IncomingMessage } from 'node:http';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, test, vi } from 'vitest';
import httpSignature from '@peertube/http-signature';
import { DI } from '@/di-symbols.js';
import { InboxProcessorService } from '@/queue/processors/InboxProcessorService.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { ApDbResolverService } from '@/core/activitypub/ApDbResolverService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { JsonLdService } from '@/core/activitypub/JsonLdService.js';
import { ApRequestCreator } from '@/core/activitypub/ApRequestService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { FetchInstanceMetadataService } from '@/core/FetchInstanceMetadataService.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import ApRequestChart from '@/core/chart/charts/ap-request.js';
import FederationChart from '@/core/chart/charts/federation.js';
import { genRsaKeyPair } from '@/misc/gen-key-pair.js';

type KeyPair = Awaited<ReturnType<typeof genRsaKeyPair>>;

async function createJob(keypair: KeyPair, keyId: string, actorUri: string, activityId: string) {
	const activity = {
		id: activityId,
		type: 'Create',
		actor: actorUri,
	};
	const body = JSON.stringify(activity);
	const signed = await ApRequestCreator.createSignedPost({
		key: { keyId, privateKeyPem: keypair.privateKey },
		url: 'https://test.example.com/inbox',
		body,
		additionalHeaders: {},
	});
	const headers: Record<string, string> = {
		...signed.request.headers,
		host: 'test.example.com',
	};
	const raw = {
		method: 'POST',
		url: '/inbox',
		headers,
		httpVersion: '1.1',
	};
	const signature = httpSignature.parseRequest(raw as unknown as IncomingMessage, {
		headers: ['(request-target)', 'host', 'date', 'digest'],
		authorizationHeaderName: 'signature',
	});

	return {
		data: { activity, signature },
	} as never;
}

const fixtures: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map(f => f.close()));
});

async function setupFixture() {
	const blockedHosts = new Set<string>();
	const performActivity = vi.fn().mockResolvedValue('ok');
	const instancesRepository = {
		findOneBy: vi.fn().mockResolvedValue(null),
	};
	const utilityService = {
		toPuny: vi.fn((host: string) => domainToASCII(host.toLowerCase())),
		isFederationAllowedHost: vi.fn((host: string) => !blockedHosts.has(host)),
		extractDbHost: vi.fn((uri: string) => new URL(uri).host.toLowerCase()),
		isSelfHost: vi.fn(() => false),
	};
	const apDbResolverService = {
		getAuthUserFromKeyId: vi.fn().mockResolvedValue(null),
		getAuthUserFromApId: vi.fn(),
	};
	const meta = { federation: 'all', blockedHosts: [] as string[], enableStatsForFederatedInstances: false, enableChartsForFederatedInstances: false };

	const app = await Test.createTestingModule({
		providers: [
			InboxProcessorService,
			{ provide: DI.meta, useValue: meta },
			{ provide: DI.instancesRepository, useValue: instancesRepository },
			{ provide: UtilityService, useValue: utilityService },
			{ provide: ApInboxService, useValue: { performActivity } },
			{ provide: ApDbResolverService, useValue: apDbResolverService },
			{ provide: ApPersonService, useValue: { resolvePerson: vi.fn() } },
			{ provide: JsonLdService, useValue: { use: vi.fn() } },
			{ provide: FederatedInstanceService, useValue: { fetch: vi.fn().mockResolvedValue(null), fetchOrRegister: vi.fn().mockResolvedValue(null) } },
			{ provide: FetchInstanceMetadataService, useValue: { fetchInstanceMetadata: vi.fn() } },
			{ provide: InstanceChart, useValue: { requestReceived: vi.fn() } },
			{ provide: ApRequestChart, useValue: { inbox: vi.fn() } },
			{ provide: FederationChart, useValue: { inbox: vi.fn() } },
			{
				provide: QueueLoggerService,
				useValue: {
					logger: {
						createSubLogger: () => ({
							debug: vi.fn(),
							info: vi.fn(),
							warn: vi.fn(),
							error: vi.fn(),
							succ: vi.fn(),
						}),
					},
				},
			},
		],
	}).compile();

	const service = app.get(InboxProcessorService);
	const fixture = {
		service,
		blockedHosts,
		meta,
		performActivity,
		instancesRepository,
		utilityService,
		apDbResolverService,
		async close() {
			await app.close();
		},
	};
	fixtures.push(fixture);
	return fixture;
}

describe('InboxProcessorService authenticated actor checks', () => {
	test('rejects a blocked actor authenticated through an allowed keyId', async () => {
		const f = await setupFixture();
		const keypair = await genRsaKeyPair();
		const actorUri = 'https://blocked.example/users/mallory';
		const keyId = 'https://allowed.example/users/mallory#main-key';
		const job = await createJob(keypair, keyId, actorUri, 'https://blocked.example/activities/1');

		f.blockedHosts.add('blocked.example');
		f.apDbResolverService.getAuthUserFromApId.mockResolvedValue({
			user: { uri: actorUri, host: 'blocked.example' },
			key: { keyPem: keypair.publicKey },
		});

		await expect(f.service.process(job)).rejects.toThrow(/Blocked request: blocked\.example/);
		expect(f.performActivity).not.toHaveBeenCalled();
	});

	test('rejects a quarantined actor authenticated through an allowed keyId', async () => {
		const f = await setupFixture();
		const keypair = await genRsaKeyPair();
		const actorUri = 'https://quarantined.example/users/mallory';
		const keyId = 'https://allowed.example/users/mallory#main-key';
		const job = await createJob(keypair, keyId, actorUri, 'https://quarantined.example/activities/1');

		f.apDbResolverService.getAuthUserFromApId.mockResolvedValue({
			user: { uri: actorUri, host: 'quarantined.example' },
			key: { keyPem: keypair.publicKey },
		});
		f.instancesRepository.findOneBy.mockResolvedValue({ quarantineLimited: true });

		await expect(f.service.process(job)).rejects.toThrow(/quarantined instance quarantined\.example/);
		expect(f.instancesRepository.findOneBy).toHaveBeenCalledWith({ host: 'quarantined.example' });
		expect(f.performActivity).not.toHaveBeenCalled();
	});

	test('rejects a quarantined actor whose instance row is stored with host:port', async () => {
		const f = await setupFixture();
		const keypair = await genRsaKeyPair();
		const actorUri = 'https://quarantined.example:8443/users/mallory';
		const keyId = 'https://allowed.example/users/mallory#main-key';
		const job = await createJob(keypair, keyId, actorUri, 'https://quarantined.example:8443/activities/1');

		f.apDbResolverService.getAuthUserFromApId.mockResolvedValue({
			user: { uri: actorUri, host: 'quarantined.example:8443' },
			key: { keyPem: keypair.publicKey },
		});
		f.instancesRepository.findOneBy.mockImplementation(async (where: { host: string } | Array<{ host: string }>) => {
			const conditions = Array.isArray(where) ? where : [where];
			return conditions.some(condition => condition.host === 'quarantined.example:8443')
				? { quarantineLimited: true }
				: null;
		});

		await expect(f.service.process(job)).rejects.toThrow(/quarantined instance quarantined\.example/);
		expect(f.performActivity).not.toHaveBeenCalled();
	});

	test('rejects a quarantined actor whose instance row is stored without a port', async () => {
		const f = await setupFixture();
		const keypair = await genRsaKeyPair();
		const actorUri = 'https://quarantined.example:8443/users/mallory';
		const keyId = 'https://allowed.example/users/mallory#main-key';
		const job = await createJob(keypair, keyId, actorUri, 'https://quarantined.example:8443/activities/1');

		f.apDbResolverService.getAuthUserFromApId.mockResolvedValue({
			user: { uri: actorUri, host: 'quarantined.example:8443' },
			key: { keyPem: keypair.publicKey },
		});
		f.instancesRepository.findOneBy.mockImplementation(async (where: { host: string } | Array<{ host: string }>) => {
			const conditions = Array.isArray(where) ? where : [where];
			return conditions.some(condition => condition.host === 'quarantined.example')
				? { quarantineLimited: true }
				: null;
		});

		await expect(f.service.process(job)).rejects.toThrow(/quarantined instance quarantined\.example/);
		expect(f.performActivity).not.toHaveBeenCalled();
	});

	test('does not let an unrestricted normalized row shadow a quarantined port row', async () => {
		const f = await setupFixture();
		const keypair = await genRsaKeyPair();
		const actorUri = 'https://quarantined.example:8443/users/mallory';
		const keyId = 'https://allowed.example/users/mallory#main-key';
		const job = await createJob(keypair, keyId, actorUri, 'https://quarantined.example:8443/activities/1');

		f.apDbResolverService.getAuthUserFromApId.mockResolvedValue({
			user: { uri: actorUri, host: 'quarantined.example:8443' },
			key: { keyPem: keypair.publicKey },
		});
		f.instancesRepository.findOneBy.mockImplementation(async (where: { host: string }) => {
			if (where.host === 'quarantined.example:8443') return { quarantineLimited: true };
			if (where.host === 'quarantined.example') return { quarantineLimited: false };
			return null;
		});

		await expect(f.service.process(job)).rejects.toThrow(/quarantined instance quarantined\.example/);
		expect(f.performActivity).not.toHaveBeenCalled();
	});

	test('does not let an unrestricted normalized row shadow a quarantined trailing-dot port row', async () => {
		const f = await setupFixture();
		const keypair = await genRsaKeyPair();
		const actorUri = 'https://quarantined.example.:8443/users/mallory';
		const keyId = 'https://allowed.example/users/mallory#main-key';
		const job = await createJob(keypair, keyId, actorUri, 'https://quarantined.example.:8443/activities/1');

		f.apDbResolverService.getAuthUserFromApId.mockResolvedValue({
			user: { uri: actorUri, host: 'quarantined.example.:8443' },
			key: { keyPem: keypair.publicKey },
		});
		f.instancesRepository.findOneBy.mockImplementation(async (where: { host: string }) => {
			if (where.host === 'quarantined.example:8443') return { quarantineLimited: true };
			if (where.host === 'quarantined.example') return { quarantineLimited: false };
			return null;
		});

		await expect(f.service.process(job)).rejects.toThrow(/quarantined instance quarantined\.example/);
		expect(f.performActivity).not.toHaveBeenCalled();
	});

	test('rejects a dotless actor when quarantine is stored with a trailing dot', async () => {
		const f = await setupFixture();
		const keypair = await genRsaKeyPair();
		const actorUri = 'https://quarantined.example/users/mallory';
		const keyId = 'https://allowed.example/users/mallory#main-key';
		const job = await createJob(keypair, keyId, actorUri, 'https://quarantined.example/activities/1');

		f.apDbResolverService.getAuthUserFromApId.mockResolvedValue({
			user: { uri: actorUri, host: 'quarantined.example' },
			key: { keyPem: keypair.publicKey },
		});
		f.instancesRepository.findOneBy.mockImplementation(async (where: { host: string }) => {
			if (where.host === 'quarantined.example.') return { quarantineLimited: true };
			if (where.host === 'quarantined.example') return { quarantineLimited: false };
			return null;
		});

		await expect(f.service.process(job)).rejects.toThrow(/quarantined instance quarantined\.example/);
		expect(f.performActivity).not.toHaveBeenCalled();
	});

	test('rejects a dotless actor with port when quarantine is stored with a dotted host:port', async () => {
		const f = await setupFixture();
		const keypair = await genRsaKeyPair();
		const actorUri = 'https://quarantined.example:8443/users/mallory';
		const keyId = 'https://allowed.example/users/mallory#main-key';
		const job = await createJob(keypair, keyId, actorUri, 'https://quarantined.example:8443/activities/1');

		f.apDbResolverService.getAuthUserFromApId.mockResolvedValue({
			user: { uri: actorUri, host: 'quarantined.example:8443' },
			key: { keyPem: keypair.publicKey },
		});
		f.instancesRepository.findOneBy.mockImplementation(async (where: { host: string }) => {
			if (where.host === 'quarantined.example.:8443') return { quarantineLimited: true };
			if (where.host === 'quarantined.example:8443') return { quarantineLimited: false };
			return null;
		});

		await expect(f.service.process(job)).rejects.toThrow(/quarantined instance quarantined\.example/);
		expect(f.performActivity).not.toHaveBeenCalled();
	});

	test('rejects an actor matching a port-bearing blocklist entry', async () => {
		const f = await setupFixture();
		const keypair = await genRsaKeyPair();
		const actorUri = 'https://blocked.example:8443/users/mallory';
		const keyId = 'https://allowed.example/users/mallory#main-key';
		const job = await createJob(keypair, keyId, actorUri, 'https://blocked.example:8443/activities/1');

		f.meta.blockedHosts = ['blocked.example:8443'];
		f.apDbResolverService.getAuthUserFromApId.mockResolvedValue({
			user: { uri: actorUri, host: 'blocked.example:8443' },
			key: { keyPem: keypair.publicKey },
		});

		await expect(f.service.process(job)).rejects.toThrow(/Blocked request: blocked\.example/);
		expect(f.performActivity).not.toHaveBeenCalled();
	});

	test('rejects a trailing-dot keyId host before resolving the signer', async () => {
		const f = await setupFixture();
		const keypair = await genRsaKeyPair();
		const actorUri = 'https://blocked.example./users/mallory';
		const keyId = 'https://blocked.example./users/mallory#main-key';
		const job = await createJob(keypair, keyId, actorUri, 'https://blocked.example./activities/1');

		f.meta.blockedHosts = ['blocked.example'];

		await expect(f.service.process(job)).resolves.toMatch(/^Blocked request: /);
		expect(f.apDbResolverService.getAuthUserFromKeyId).not.toHaveBeenCalled();
		expect(f.performActivity).not.toHaveBeenCalled();
	});

	test('normalizes the authenticated actor host before blocklist lookups', async () => {
		const f = await setupFixture();
		const keypair = await genRsaKeyPair();
		const actorUri = 'https://blocked.example:8443/users/mallory';
		const keyId = 'https://allowed.example/users/mallory#main-key';
		const job = await createJob(keypair, keyId, actorUri, 'https://blocked.example:8443/activities/1');

		f.blockedHosts.add('blocked.example');
		f.apDbResolverService.getAuthUserFromApId.mockResolvedValue({
			user: { uri: actorUri, host: 'blocked.example:8443' },
			key: { keyPem: keypair.publicKey },
		});

		await expect(f.service.process(job)).rejects.toThrow(/Blocked request: blocked\.example/);
		expect(f.performActivity).not.toHaveBeenCalled();
	});

	test('accepts an allowed actor resolved from an unknown keyId', async () => {
		const f = await setupFixture();
		const keypair = await genRsaKeyPair();
		const actorUri = 'https://allowed.example/users/alice';
		const keyId = 'https://unknown.example/users/alice#main-key';
		const job = await createJob(keypair, keyId, actorUri, 'https://allowed.example/activities/1');

		f.apDbResolverService.getAuthUserFromApId.mockResolvedValue({
			user: { uri: actorUri, host: 'allowed.example' },
			key: { keyPem: keypair.publicKey },
		});

		await expect(f.service.process(job)).resolves.toBe('ok');
		expect(f.apDbResolverService.getAuthUserFromKeyId).toHaveBeenCalledWith(keyId);
		expect(f.performActivity).toHaveBeenCalledTimes(1);
	});
});
