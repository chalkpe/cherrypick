/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { domainToASCII } from 'node:url';
import { Test, TestingModule } from '@nestjs/testing';
import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { ActivityPubAccessControlService } from '@/core/ActivityPubAccessControlService.js';
import { ApDbResolverService } from '@/core/activitypub/ApDbResolverService.js';
import { ApRequestCreator } from '@/core/activitypub/ApRequestService.js';
import { genRsaKeyPair } from '@/misc/gen-key-pair.js';
import { DI } from '@/di-symbols.js';
import { UtilityService } from '@/core/UtilityService.js';
import { LoggerService } from '@/core/LoggerService.js';
import type { MiNote } from '@/models/Note.js';

function toRequest(signed: { request: { method: string; url: string; headers: Record<string, string> } }, host: string): FastifyRequest {
	const url = new URL(signed.request.url);
	const headers: Record<string, string> = {
		...signed.request.headers,
		host,
	};

	return {
		headers,
		raw: {
			method: signed.request.method,
			url: `${url.pathname}${url.search}`,
			headers,
			httpVersion: '1.1',
		},
	} as unknown as FastifyRequest;
}

function noteWithTargets(deliveryTargets: MiNote['deliveryTargets']): Pick<MiNote, 'id' | 'deliveryTargets'> {
	return { id: 'note1', deliveryTargets };
}

describe('ActivityPubAccessControlService', () => {
	let service: ActivityPubAccessControlService;
	let mockInstancesRepository: any;
	let mockUtilityService: any;
	let mockLoggerService: any;
	let mockConfig: any;
	let mockMeta: any;
	let mockApDbResolverService: any;

	beforeEach(async () => {
		mockInstancesRepository = {
			findOneBy: vi.fn(),
		};

		mockUtilityService = {
			// Mirror UtilityService.toPuny: domainToASCII returns '' for host:port.
			toPuny: vi.fn((host: string) => domainToASCII(host.toLowerCase())),
			toPunyNullable: vi.fn((host: string | null | undefined) => host == null ? null : domainToASCII(host.toLowerCase())),
			punyHost: vi.fn((uri: string) => {
				const url = new URL(uri);
				return url.hostname.toLowerCase() + (url.port.length > 0 ? `:${url.port}` : '');
			}),
			isSelfHost: vi.fn((host: string | null) => host == null || host.toLowerCase() === 'test.example.com'),
			extractDbHost: vi.fn((uri: string) => new URL(uri).host.toLowerCase()),
			isBlockedHost: vi.fn(() => false),
			isSilencedHost: vi.fn(() => false),
		};

		mockLoggerService = {
			getLogger: vi.fn(() => ({
				info: vi.fn(),
				debug: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			})),
		};

		mockConfig = {
			host: 'test.example.com',
		};

		mockMeta = {
			blockedHosts: [],
			silencedHosts: [],
		};

		mockApDbResolverService = {
			getAuthUserFromKeyId: vi.fn(),
		};

		const module: TestingModule = await Test.createTestingModule({
			providers: [
				ActivityPubAccessControlService,
				{ provide: DI.config, useValue: mockConfig },
				{ provide: DI.meta, useValue: mockMeta },
				{ provide: DI.instancesRepository, useValue: mockInstancesRepository },
				{ provide: UtilityService, useValue: mockUtilityService },
				{ provide: LoggerService, useValue: mockLoggerService },
				{ provide: ApDbResolverService, useValue: mockApDbResolverService },
			],
		}).compile();

		service = module.get<ActivityPubAccessControlService>(ActivityPubAccessControlService);
	});

	test('should be defined', () => {
		expect(service).toBeDefined();
	});

	describe('resolveRemoteHostFromRequest', () => {
		test('returns null when the request has no HTTP Signature', async () => {
			const request = {
				headers: {},
			} as FastifyRequest;

			expect(await service.resolveRemoteHostFromRequest(request)).toBeNull();
			expect(mockApDbResolverService.getAuthUserFromKeyId).not.toHaveBeenCalled();
		});

		test('ignores User-Agent when no HTTP Signature is present', async () => {
			const request = {
				headers: {
					'user-agent': 'http.rb/5.3.0 (Mastodon/4.2.0; +https://allowed.example/)',
				},
			} as FastifyRequest;

			expect(await service.resolveRemoteHostFromRequest(request)).toBeNull();
		});

		test('returns the verified actor host from the signature keyId', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'https://allowed.example/users/alice#main-key';
			const actorUri = 'https://allowed.example/users/alice';

			mockApDbResolverService.getAuthUserFromKeyId.mockResolvedValue({
				user: { uri: actorUri, host: 'allowed.example' },
				key: { keyPem: keypair.publicKey },
			});

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: {},
			});

			const request = toRequest(signed, 'test.example.com');

			expect(await service.resolveRemoteHostFromRequest(request)).toBe('allowed.example');
			expect(mockApDbResolverService.getAuthUserFromKeyId).toHaveBeenCalledWith(keyId);
		});

		test('rejects a replay that supplies a fresh unsigned X-Date', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'https://allowed.example/users/alice#main-key';

			mockApDbResolverService.getAuthUserFromKeyId.mockResolvedValue({
				user: { uri: 'https://allowed.example/users/alice', host: 'allowed.example' },
				key: { keyPem: keypair.publicKey },
			});

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: {
					'Date': new Date(Date.now() - 10 * 60 * 1000).toUTCString(),
					'X-Date': new Date().toUTCString(),
				},
			});

			expect(await service.resolveRemoteHostFromRequest(toRequest(signed, 'test.example.com'))).toBeNull();
		});

		test('rejects a signed Date older than the clock skew', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'https://allowed.example/users/alice#main-key';

			mockApDbResolverService.getAuthUserFromKeyId.mockResolvedValue({
				user: { uri: 'https://allowed.example/users/alice', host: 'allowed.example' },
				key: { keyPem: keypair.publicKey },
			});

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: {
					'Date': new Date(Date.now() - 10 * 60 * 1000).toUTCString(),
				},
			});

			expect(await service.resolveRemoteHostFromRequest(toRequest(signed, 'test.example.com'))).toBeNull();
		});

		test('returns the raw actor host with port so quarantine rows can match', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'https://quarantined.example:8443/users/alice#main-key';
			const actorUri = 'https://quarantined.example:8443/users/alice';

			mockApDbResolverService.getAuthUserFromKeyId.mockResolvedValue({
				user: { uri: actorUri, host: 'quarantined.example:8443' },
				key: { keyPem: keypair.publicKey },
			});

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: {},
			});

			const request = toRequest(signed, 'test.example.com');

			expect(await service.resolveRemoteHostFromRequest(request)).toBe('quarantined.example:8443');
		});

		test('ignores a spoofed User-Agent when a signature is present', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'https://allowed.example/users/alice#main-key';

			mockApDbResolverService.getAuthUserFromKeyId.mockResolvedValue({
				user: { uri: 'https://allowed.example/users/alice', host: 'allowed.example' },
				key: { keyPem: keypair.publicKey },
			});

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: { 'User-Agent': 'Mastodon/4.2.0 (+https://blocked.example)' },
			});

			const request = toRequest(signed, 'test.example.com');

			expect(await service.resolveRemoteHostFromRequest(request)).toBe('allowed.example');
		});

		test('returns null when the signature does not verify', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'https://allowed.example/users/alice#main-key';

			mockApDbResolverService.getAuthUserFromKeyId.mockResolvedValue({
				user: { uri: 'https://allowed.example/users/alice', host: 'allowed.example' },
				key: { keyPem: keypair.publicKey },
			});

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: {},
			});

			const request = toRequest(signed, 'test.example.com');
			// Tamper with the request target after signing.
			(request.raw as any).url = '/notes/another-note';

			expect(await service.resolveRemoteHostFromRequest(request)).toBeNull();
		});

		test('returns null when the signing key is unknown', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'https://unknown.example/users/alice#main-key';

			mockApDbResolverService.getAuthUserFromKeyId.mockResolvedValue(null);

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: {},
			});

			const request = toRequest(signed, 'test.example.com');

			expect(await service.resolveRemoteHostFromRequest(request)).toBeNull();
		});

		test('returns null when the keyId host does not match the actor host', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'https://allowed.example/users/alice#main-key';

			mockApDbResolverService.getAuthUserFromKeyId.mockResolvedValue({
				user: { uri: 'https://other.example/users/alice', host: 'other.example' },
				key: { keyPem: keypair.publicKey },
			});

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: {},
			});

			const request = toRequest(signed, 'test.example.com');

			expect(await service.resolveRemoteHostFromRequest(request)).toBeNull();
		});

		test('keeps a non-standard port in the raw host for quarantine lookups', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'https://allowed.example:8443/users/alice#main-key';

			mockApDbResolverService.getAuthUserFromKeyId.mockResolvedValue({
				user: { uri: 'https://allowed.example:8443/users/alice', host: 'allowed.example:8443' },
				key: { keyPem: keypair.publicKey },
			});

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: {},
			});

			expect(await service.resolveRemoteHostFromRequest(toRequest(signed, 'test.example.com'))).toBe('allowed.example:8443');
		});

		test('normalizes keyId hosts and rejects malformed hosts', () => {
			expect(service.extractHostFromKeyId('https://allowed.example:8443/users/alice#main-key')).toBe('allowed.example');
			expect(service.extractHostFromKeyId('https://allowed.example:99999/users/alice#main-key')).toBeNull();
			expect(service.extractHostFromKeyId('not-a-url')).toBeNull();
		});

		test('returns null for a malformed keyId', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'not-a-url';

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: {},
			});

			const request = toRequest(signed, 'test.example.com');

			expect(await service.resolveRemoteHostFromRequest(request)).toBeNull();
			expect(mockApDbResolverService.getAuthUserFromKeyId).not.toHaveBeenCalled();
		});
	});

	describe('extractHostFromKeyId', () => {
		test('strips a trailing FQDN dot so blocklist matching cannot be bypassed', () => {
			expect(service.extractHostFromKeyId('https://blocked.example./users/eve#main-key')).toBe('blocked.example');
		});

		test('strips a trailing FQDN dot and ignores the port', () => {
			expect(service.extractHostFromKeyId('https://blocked.example.:8443/users/eve#main-key')).toBe('blocked.example');
		});
	});

	describe('checkAccess', () => {
		test('allows an unsigned request with no identifiable host (public GET policy)', async () => {
			const request = {
				headers: {
					'user-agent': 'curl/8.0',
				},
			} as FastifyRequest;

			expect(await service.checkAccess(request)).toBeNull();
		});

		test('does not block based on User-Agent alone', async () => {
			mockMeta.blockedHosts = ['blocked.example'];

			const request = {
				headers: {
					'user-agent': 'http.rb/5.3.0 (Mastodon/4.2.0; +https://blocked.example/)',
				},
			} as FastifyRequest;

			expect(await service.checkAccess(request)).toBeNull();
		});

		test('blocks a host identified by a verified signature', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'https://blocked.example/users/alice#main-key';

			mockApDbResolverService.getAuthUserFromKeyId.mockResolvedValue({
				user: { uri: 'https://blocked.example/users/alice', host: 'blocked.example' },
				key: { keyPem: keypair.publicKey },
			});
			mockMeta.blockedHosts = ['blocked.example'];

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: {},
			});

			expect(await service.checkAccess(toRequest(signed, 'test.example.com'))).toEqual({
				blocked: true,
				reason: 'blocked',
				host: 'blocked.example',
			});
		});

		test('ignores a User-Agent that claims an allowed host when the signature says blocked', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'https://blocked.example/users/alice#main-key';

			mockApDbResolverService.getAuthUserFromKeyId.mockResolvedValue({
				user: { uri: 'https://blocked.example/users/alice', host: 'blocked.example' },
				key: { keyPem: keypair.publicKey },
			});
			mockMeta.blockedHosts = ['blocked.example'];

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: { 'User-Agent': 'Mastodon/4.2.0 (+https://allowed.example)' },
			});

			const result = await service.checkAccess(toRequest(signed, 'test.example.com'));
			expect(result?.host).toBe('blocked.example');
		});

		test('denies a quarantined host even when limited hosts are allowed', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'https://quarantined.example/users/alice#main-key';

			mockApDbResolverService.getAuthUserFromKeyId.mockResolvedValue({
				user: { uri: 'https://quarantined.example/users/alice', host: 'quarantined.example' },
				key: { keyPem: keypair.publicKey },
			});
			mockInstancesRepository.findOneBy.mockResolvedValue({ quarantineLimited: true });

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: {},
			});

			expect(await service.checkAccess(toRequest(signed, 'test.example.com'), true)).toEqual({
				blocked: true,
				reason: 'quarantined',
				host: 'quarantined.example',
			});
		});

		test('blocks a signed GET when the quarantine row is stored with host:port', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'https://quarantined.example:8443/users/alice#main-key';

			mockApDbResolverService.getAuthUserFromKeyId.mockResolvedValue({
				user: { uri: 'https://quarantined.example:8443/users/alice', host: 'quarantined.example:8443' },
				key: { keyPem: keypair.publicKey },
			});
			mockInstancesRepository.findOneBy.mockImplementation(async ({ host }: { host: string }) => {
				return host === 'quarantined.example:8443' ? { quarantineLimited: true } : null;
			});

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: {},
			});

			expect(await service.checkAccess(toRequest(signed, 'test.example.com'), true)).toEqual({
				blocked: true,
				reason: 'quarantined',
				host: 'quarantined.example',
			});
		});

		test('blocks a signed GET when the quarantine row is stored with a trailing dot', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'https://quarantined.example./users/alice#main-key';

			mockApDbResolverService.getAuthUserFromKeyId.mockResolvedValue({
				user: { uri: 'https://quarantined.example./users/alice', host: 'quarantined.example.' },
				key: { keyPem: keypair.publicKey },
			});
			mockInstancesRepository.findOneBy.mockImplementation(async ({ host }: { host: string }) => {
				return host === 'quarantined.example.' ? { quarantineLimited: true } : null;
			});

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: {},
			});

			expect(await service.checkAccess(toRequest(signed, 'test.example.com'), true)).toEqual({
				blocked: true,
				reason: 'quarantined',
				host: 'quarantined.example',
			});
		});

		test('allows a silenced host when limited hosts are allowed', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'https://silenced.example/users/alice#main-key';

			mockApDbResolverService.getAuthUserFromKeyId.mockResolvedValue({
				user: { uri: 'https://silenced.example/users/alice', host: 'silenced.example' },
				key: { keyPem: keypair.publicKey },
			});
			mockMeta.silencedHosts = ['silenced.example'];
			mockInstancesRepository.findOneBy.mockResolvedValue(null);

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: {},
			});

			expect(await service.checkAccess(toRequest(signed, 'test.example.com'), true)).toBeNull();
		});

		test('treats an invalid signature as an unknown host for public GETs', async () => {
			const keypair = await genRsaKeyPair();
			const keyId = 'https://blocked.example/users/alice#main-key';

			mockApDbResolverService.getAuthUserFromKeyId.mockResolvedValue({
				user: { uri: 'https://blocked.example/users/alice', host: 'blocked.example' },
				key: { keyPem: keypair.publicKey },
			});
			mockMeta.blockedHosts = ['blocked.example'];

			const signed = await ApRequestCreator.createSignedGet({
				key: { keyId, privateKeyPem: keypair.privateKey },
				url: 'https://test.example.com/notes/note1',
				additionalHeaders: {},
			});

			const request = toRequest(signed, 'test.example.com');
			(request.raw as any).url = '/notes/another-note';

			// The request is anonymous, so public content remains available; restricted
			// notes are denied separately by checkNoteAccess (fail closed).
			expect(await service.checkAccess(request)).toBeNull();
		});
	});

	describe('checkNoteAccess', () => {
		test('allows notes without delivery targets for unknown requesters', () => {
			expect(service.checkNoteAccess(noteWithTargets(null), null)).toBe(true);
		});

		test('allows a host in the include list', () => {
			const note = noteWithTargets({ mode: 'include', hosts: ['allowed.example'] });
			expect(service.checkNoteAccess(note, 'allowed.example')).toBe(true);
		});

		test('denies a host that is not in the include list', () => {
			const note = noteWithTargets({ mode: 'include', hosts: ['allowed.example'] });
			expect(service.checkNoteAccess(note, 'other.example')).toBe(false);
		});

		test('denies an unknown host when include targets exist (fail closed)', () => {
			const note = noteWithTargets({ mode: 'include', hosts: ['allowed.example'] });
			expect(service.checkNoteAccess(note, null)).toBe(false);
		});

		test('denies an unknown host when exclude targets exist (fail closed)', () => {
			const note = noteWithTargets({ mode: 'exclude', hosts: ['blocked.example'] });
			expect(service.checkNoteAccess(note, null)).toBe(false);
		});

		test('denies a host in the exclude list', () => {
			const note = noteWithTargets({ mode: 'exclude', hosts: ['blocked.example'] });
			expect(service.checkNoteAccess(note, 'blocked.example')).toBe(false);
		});

		test('allows a host that is not in the exclude list', () => {
			const note = noteWithTargets({ mode: 'exclude', hosts: ['blocked.example'] });
			expect(service.checkNoteAccess(note, 'other.example')).toBe(true);
		});

		test('normalizes hosts before comparing', () => {
			const note = noteWithTargets({ mode: 'include', hosts: ['Allowed.Example'] });
			expect(service.checkNoteAccess(note, 'allowed.example')).toBe(true);
		});

		test('does not collide ports when matching include targets', () => {
			const note = noteWithTargets({ mode: 'include', hosts: ['allowed.example:8443'] });
			expect(service.checkNoteAccess(note, 'attacker.example:9443')).toBe(false);
		});

		test('ignores the requester port when matching include targets', () => {
			const note = noteWithTargets({ mode: 'include', hosts: ['allowed.example'] });
			expect(service.checkNoteAccess(note, 'allowed.example:8443')).toBe(true);
		});

		test('fails closed when a delivery target cannot be normalized', () => {
			const note = noteWithTargets({ mode: 'include', hosts: ['allowed.example:99999'] });
			expect(service.checkNoteAccess(note, 'allowed.example')).toBe(false);
		});

		test('fails closed when the requester host cannot be normalized', () => {
			const note = noteWithTargets({ mode: 'exclude', hosts: ['blocked.example'] });
			expect(service.checkNoteAccess(note, 'not a host')).toBe(false);
		});

		test('allows the local host', () => {
			const note = noteWithTargets({ mode: 'include', hosts: ['allowed.example'] });
			expect(service.checkNoteAccess(note, 'test.example.com')).toBe(true);
		});

		test('fails closed on an unknown delivery target mode', () => {
			const note = noteWithTargets({ mode: 'invalid' as any, hosts: ['allowed.example'] });
			expect(service.checkNoteAccess(note, 'allowed.example')).toBe(false);
		});
	});

	describe('checkHostAccess', () => {
		test('normalizes the port before blocklist lookups', async () => {
			mockMeta.blockedHosts = ['blocked.example'];

			expect(await service.checkHostAccess('blocked.example:8443', true)).toEqual({
				blocked: true,
				reason: 'blocked',
				host: 'blocked.example',
			});
		});

		test('normalizes blocklist entries that contain a port', async () => {
			mockMeta.blockedHosts = ['blocked.example:8443'];

			expect(await service.checkHostAccess('blocked.example:8443', true)).toMatchObject({
				blocked: true,
				reason: 'blocked',
			});
		});

		test('normalizes blocklist entries with a trailing dot', async () => {
			mockMeta.blockedHosts = ['blocked.example.'];

			expect(await service.checkHostAccess('blocked.example', true)).toMatchObject({
				blocked: true,
				reason: 'blocked',
			});
		});

		test('normalizes Unicode blocklist entries to punycode', async () => {
			mockMeta.blockedHosts = ['bücher.example'];

			expect(await service.checkHostAccess('xn--bcher-kva.example', true)).toMatchObject({
				blocked: true,
				reason: 'blocked',
			});
		});

		test('normalizes mixed-case silence entries', async () => {
			mockMeta.silencedHosts = ['Silenced.Example'];

			expect(await service.checkHostAccess('silenced.example', false)).toMatchObject({
				blocked: true,
				reason: 'silenced',
			});
		});

		test('normalizes the port before quarantine lookups', async () => {
			mockInstancesRepository.findOneBy.mockResolvedValue({ quarantineLimited: true });

			expect(await service.checkHostAccess('quarantined.example:8443', true)).toEqual({
				blocked: true,
				reason: 'quarantined',
				host: 'quarantined.example',
			});
			expect(mockInstancesRepository.findOneBy).toHaveBeenCalledWith({ host: 'quarantined.example' });
		});

		test('does not let an unrestricted row shadow a quarantined port row', async () => {
			mockInstancesRepository.findOneBy.mockImplementation(async ({ host }: { host: string }) => {
				if (host === 'quarantined.example') return { quarantineLimited: false };
				if (host === 'quarantined.example:8443') return { quarantineLimited: true };
				return null;
			});

			expect(await service.checkHostAccess('quarantined.example:8443', true)).toMatchObject({
				blocked: true,
				reason: 'quarantined',
				host: 'quarantined.example',
			});
		});

		test('finds a quarantine row stored with a host:port from a port-bearing actor', async () => {
			mockInstancesRepository.findOneBy.mockImplementation(async (where: { host: string } | Array<{ host: string }>) => {
				const conditions = Array.isArray(where) ? where : [where];
				return conditions.some(condition => condition.host === 'quarantined.example:8443')
					? { quarantineLimited: true }
					: null;
			});

			expect(await service.checkHostAccess('quarantined.example:8443', true)).toMatchObject({
				blocked: true,
				reason: 'quarantined',
				host: 'quarantined.example',
			});
		});

		test('finds a quarantine row stored with a trailing-dot host:port', async () => {
			mockInstancesRepository.findOneBy.mockImplementation(async ({ host }: { host: string }) => {
				return host === 'quarantined.example:8443' ? { quarantineLimited: true } : null;
			});

			expect(await service.checkHostAccess('quarantined.example.:8443', true)).toMatchObject({
				blocked: true,
				reason: 'quarantined',
				host: 'quarantined.example',
			});
		});

		test('finds a dotted quarantine row when the requester is dotless', async () => {
			mockInstancesRepository.findOneBy.mockImplementation(async ({ host }: { host: string }) => {
				if (host === 'quarantined.example') return { quarantineLimited: false };
				if (host === 'quarantined.example.') return { quarantineLimited: true };
				return null;
			});

			expect(await service.checkHostAccess('quarantined.example', true)).toMatchObject({
				blocked: true,
				reason: 'quarantined',
				host: 'quarantined.example',
			});
		});

		test('finds a dotted quarantine row with port when the requester is dotless', async () => {
			mockInstancesRepository.findOneBy.mockImplementation(async ({ host }: { host: string }) => {
				if (host === 'quarantined.example:8443') return { quarantineLimited: false };
				if (host === 'quarantined.example.:8443') return { quarantineLimited: true };
				return null;
			});

			expect(await service.checkHostAccess('quarantined.example:8443', true)).toMatchObject({
				blocked: true,
				reason: 'quarantined',
				host: 'quarantined.example',
			});
		});

		test('allows the local host when the input includes a port', async () => {
			expect(await service.checkHostAccess('test.example.com:8443')).toBeNull();
		});

		test('fails closed when the host cannot be normalized', async () => {
			expect(await service.checkHostAccess('not a host')).toMatchObject({
				blocked: true,
				reason: 'invalid-host',
			});
		});
	});
});
