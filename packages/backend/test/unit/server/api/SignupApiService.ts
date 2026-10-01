/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { Test, TestingModule } from '@nestjs/testing';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MiMeta, RegistrationTicketsRepository, UserPendingsRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import { EmailService } from '@/core/EmailService.js';
import { UserService } from '@/core/UserService.js';
import { SignupApiService } from '@/server/api/SignupApiService.js';
import { SigninService } from '@/server/api/SigninService.js';
import { RateLimiterService } from '@/server/api/RateLimiterService.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { SIGNUP_PENDING_EXPIRES_IN } from '@/const.js';

class FakeLimiter {
	public limited = false;

	public async limit() {
		return this.limited ? { blocked: true, remaining: 0, resetSec: 60, resetMs: 60000, fullResetSec: 60, fullResetMs: 60000 } : null;
	}
}

class FakeSigninService {
	public signin() {
		return { signedIn: true };
	}
}

class DummyFastifyReply {
	public statusCode = 200;
	code(num: number) {
		this.statusCode = num;
		return this;
	}
}

type SignupPendingRequest = FastifyRequest<{ Body: { code: string } }>;

function request(code: unknown): SignupPendingRequest {
	return { ip: '0.0.0.0', body: { code } } as unknown as SignupPendingRequest;
}

describe('SignupApiService', () => {
	let app: TestingModule;
	let service: SignupApiService;
	let idService: IdService;
	let meta: MiMeta;
	let limiter: FakeLimiter;
	let sendEmail: ReturnType<typeof vi.fn>;
	let usersRepository: UsersRepository;
	let userProfilesRepository: UserProfilesRepository;
	let userPendingsRepository: UserPendingsRepository;
	let registrationTicketsRepository: RegistrationTicketsRepository;

	async function createPending(ageMs: number) {
		const username = `p${secureRndstr(12, { chars: 'abcdefghijklmnopqrstuvwxyz0123456789' })}`;
		return await userPendingsRepository.insertOne({
			id: idService.gen(Date.now() - ageMs),
			code: secureRndstr(16),
			email: `${username}@example.com`,
			username,
			password: 'hash',
			reason: '',
		});
	}

	beforeAll(async () => {
		sendEmail = vi.fn();

		app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
			providers: [
				SignupApiService,
				{ provide: RateLimiterService, useClass: FakeLimiter },
				{ provide: SigninService, useClass: FakeSigninService },
			],
		})
			.overrideProvider(EmailService).useValue({ sendEmail })
			// 作成通知の Webhook は対象外
			.overrideProvider(UserService).useValue({ notifySystemWebhook: vi.fn() })
			.useMocker((token) => {
				if (typeof token === 'function') {
					return mockDeep<typeof token>();
				}
			})
			.compile();

		service = app.get(SignupApiService);
		idService = app.get(IdService);
		meta = app.get(DI.meta);
		limiter = app.get(RateLimiterService) as unknown as FakeLimiter;
		usersRepository = app.get(DI.usersRepository);
		userProfilesRepository = app.get(DI.userProfilesRepository);
		userPendingsRepository = app.get(DI.userPendingsRepository);
		registrationTicketsRepository = app.get(DI.registrationTicketsRepository);
	});

	beforeEach(() => {
		sendEmail.mockClear();
		limiter.limited = false;
		meta.emailRequiredForSignup = true;
		meta.approvalRequiredForSignup = false;
		meta.disableRegistration = false;
	});

	afterAll(async () => {
		await app.close();
	});

	describe('signupPending', () => {
		test('rejects an unknown code with NO_SUCH_CODE', async () => {
			const reply = new DummyFastifyReply();
			const res = await service.signupPending(request('nonexistentcode'), reply as unknown as FastifyReply);

			expect(reply.statusCode).toBe(400);
			expect(res).toMatchObject({ error: { code: 'NO_SUCH_CODE' } });
		});

		test('rejects an expired code with EXPIRED', async () => {
			const pending = await createPending(SIGNUP_PENDING_EXPIRES_IN + 60_000);

			const reply = new DummyFastifyReply();
			const res = await service.signupPending(request(pending.code), reply as unknown as FastifyReply);

			expect(reply.statusCode).toBe(400);
			expect(res).toMatchObject({ error: { code: 'EXPIRED' } });
			expect(await userPendingsRepository.existsBy({ id: pending.id })).toBe(true);
		});

		test('accepts a code older than 30 minutes', async () => {
			const pending = await createPending(1000 * 60 * 60 * 2);

			const reply = new DummyFastifyReply();
			const res = await service.signupPending(request(pending.code), reply as unknown as FastifyReply);

			expect(res).toEqual({ signedIn: true });
			const user = await usersRepository.findOneByOrFail({ usernameLower: pending.username });
			const profile = await userProfilesRepository.findOneByOrFail({ userId: user.id });
			expect(profile.email).toBe(pending.email);
			expect(profile.emailVerified).toBe(true);
		});

		test('reports pending approval instead of signing in on an approval-required server', async () => {
			const pending = await createPending(0);
			meta.approvalRequiredForSignup = true;

			const reply = new DummyFastifyReply();
			const res = await service.signupPending(request(pending.code), reply as unknown as FastifyReply);

			expect(res).toEqual({ pendingApproval: true });
			expect(await usersRepository.existsBy({ usernameLower: pending.username })).toBe(true);
		});
	});

	describe('resendSignupPending', () => {
		test('rejects an unknown code with NO_SUCH_CODE', async () => {
			const reply = new DummyFastifyReply();
			const res = await service.resendSignupPending(request('nonexistentcode'), reply as unknown as FastifyReply);

			expect(reply.statusCode).toBe(400);
			expect(res).toMatchObject({ error: { code: 'NO_SUCH_CODE' } });
			expect(sendEmail).not.toHaveBeenCalled();
		});

		test('replaces an expired request with a new code and mails it', async () => {
			const pending = await createPending(SIGNUP_PENDING_EXPIRES_IN + 60_000);

			const reply = new DummyFastifyReply();
			await service.resendSignupPending(request(pending.code), reply as unknown as FastifyReply);

			expect(reply.statusCode).toBe(204);
			expect(await userPendingsRepository.existsBy({ code: pending.code })).toBe(false);

			const renewed = await userPendingsRepository.findOneByOrFail({ username: pending.username });
			expect(renewed.code).not.toBe(pending.code);
			expect(renewed.email).toBe(pending.email);
			expect(renewed.password).toBe(pending.password);
			expect(idService.parse(renewed.id).date.getTime()).toBeGreaterThan(Date.now() - 60_000);

			expect(sendEmail).toHaveBeenCalledTimes(1);
			expect(sendEmail.mock.calls[0][0]).toBe(pending.email);
			expect(sendEmail.mock.calls[0][3]).toContain(`/signup-complete/${renewed.code}`);
		});

		test('moves the invitation code over to the new request', async () => {
			const pending = await createPending(SIGNUP_PENDING_EXPIRES_IN + 60_000);
			const ticket = await registrationTicketsRepository.insertOne({
				id: idService.gen(),
				code: secureRndstr(8),
				usedAt: new Date(Date.now() - SIGNUP_PENDING_EXPIRES_IN - 60_000),
				pendingUserId: pending.id,
			});
			meta.disableRegistration = true;

			const reply = new DummyFastifyReply();
			await service.resendSignupPending(request(pending.code), reply as unknown as FastifyReply);

			expect(reply.statusCode).toBe(204);
			const renewed = await userPendingsRepository.findOneByOrFail({ username: pending.username });
			const updated = await registrationTicketsRepository.findOneByOrFail({ id: ticket.id });
			expect(updated.pendingUserId).toBe(renewed.id);
			expect(updated.usedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
		});

		test('refuses when registration needs an invitation the request no longer holds', async () => {
			const pending = await createPending(SIGNUP_PENDING_EXPIRES_IN + 60_000);
			meta.disableRegistration = true;

			const reply = new DummyFastifyReply();
			const res = await service.resendSignupPending(request(pending.code), reply as unknown as FastifyReply);

			expect(reply.statusCode).toBe(400);
			expect(res).toMatchObject({ error: { code: 'RESEND_NOT_AVAILABLE' } });
			expect(await userPendingsRepository.existsBy({ id: pending.id })).toBe(true);
			expect(sendEmail).not.toHaveBeenCalled();
		});

		test('refuses when the username has been taken in the meantime', async () => {
			const pending = await createPending(SIGNUP_PENDING_EXPIRES_IN + 60_000);
			await usersRepository.insert({
				id: idService.gen(),
				username: pending.username,
				usernameLower: pending.username.toLowerCase(),
			});

			const reply = new DummyFastifyReply();
			const res = await service.resendSignupPending(request(pending.code), reply as unknown as FastifyReply);

			expect(reply.statusCode).toBe(400);
			expect(res).toMatchObject({ error: { code: 'RESEND_NOT_AVAILABLE' } });
			expect(sendEmail).not.toHaveBeenCalled();
		});

		test('is rate limited', async () => {
			const pending = await createPending(SIGNUP_PENDING_EXPIRES_IN + 60_000);
			limiter.limited = true;

			const reply = new DummyFastifyReply();
			const res = await service.resendSignupPending(request(pending.code), reply as unknown as FastifyReply);

			expect(reply.statusCode).toBe(429);
			expect(res).toMatchObject({ error: { code: 'RATE_LIMIT_EXCEEDED' } });
			expect(sendEmail).not.toHaveBeenCalled();
		});
	});
});
