/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SignupApiService } from '@/server/api/SignupApiService.js';

const REASON = 'please "</p><h2>x</h2><a href="https://example.test/">link</a>';

function fixture(opts: { claimed?: boolean; signupError?: Error } = {}) {
	const { claimed = true, signupError } = opts;
	const meta = {
		approvalRequiredForSignup: true, disableRegistration: true, emailRequiredForSignup: false,
		preservedUsernames: [], enableIpLogging: false,
	};
	const ticket = { id: 'ticket', code: 'code', usedById: null, usedAt: null, expiresAt: null };
	const registrationTicketsRepository = {
		findOneBy: vi.fn().mockResolvedValue(ticket),
		update: vi.fn().mockImplementation(async (where: unknown) => ({ affected: Array.isArray(where) && !claimed ? 0 : 1 })),
	};
	const account = { id: 'account', username: 'newuser' };
	const signupService = { signup: vi.fn().mockImplementation(async () => {
		if (signupError) throw signupError;
		return { account, secret: 'secret' };
	}) };
	const emailService = { sendEmail: vi.fn(), validateEmailForAccount: vi.fn().mockResolvedValue({ available: true }) };
	const userProfilesRepository = {
		findOneBy: vi.fn().mockResolvedValue({ email: 'moderator@example.com' }),
		findOneByOrFail: vi.fn().mockResolvedValue({ userId: 'account' }),
		update: vi.fn(),
	};
	const userPendingsRepository = {
		findOneBy: vi.fn().mockResolvedValue({ id: 'pending', code: 'pc', username: 'newuser', password: 'hash', reason: REASON, email: 'user@example.com' }),
		delete: vi.fn(),
	};
	const service = new SignupApiService(
		{ url: 'https://example.test' } as any, meta as any, {} as any,
		userProfilesRepository as any, userPendingsRepository as any,
		{ exists: vi.fn().mockResolvedValue(false) } as any,
		registrationTicketsRepository as any, { createQueryBuilder: vi.fn() } as any,
		{} as any, { gen: () => 'id', parse: () => ({ date: new Date() }) } as any, {} as any,
		signupService as any, {} as any, emailService as any,
		{ getModerators: vi.fn().mockResolvedValue([{ id: 'moderator' }]) } as any,
		{ getLogger: () => ({ error: vi.fn() }) } as any, {} as any,
	);
	const reply = { code: vi.fn() };
	return { service, reply, signupService, emailService, registrationTicketsRepository };
}

const request = (extra: Record<string, unknown> = {}) => ({
	ip: '127.0.0.1',
	body: { username: 'newuser', password: 'password', invitationCode: 'code', reason: REASON, emailAddress: 'someone@example.com', ...extra },
}) as any;

describe('signup with approval required', () => {
	const originalEnv = process.env.NODE_ENV;
	beforeEach(() => { process.env.NODE_ENV = 'production'; });
	afterEach(() => { process.env.NODE_ENV = originalEnv; });

	test('claims the invitation code before creating the account', async () => {
		const { service, reply, registrationTicketsRepository } = fixture();
		await service.signup(request(), reply as any);
		expect(reply.code).toHaveBeenCalledWith(204);
		const claim = registrationTicketsRepository.update.mock.calls.find(([where]) => Array.isArray(where));
		expect(claim).toBeDefined();
	});

	test('rejects the signup when the code was already claimed', async () => {
		const { service, reply, signupService } = fixture({ claimed: false });
		await service.signup(request(), reply as any);
		expect(reply.code).toHaveBeenCalledWith(400);
		expect(signupService.signup).not.toHaveBeenCalled();
	});

	test('releases the claimed code when the signup fails', async () => {
		const { service, reply, registrationTicketsRepository } = fixture({ signupError: new Error('failed') });
		await expect(service.signup(request(), reply as any)).rejects.toThrow('failed');
		const release = registrationTicketsRepository.update.mock.calls.find(([, values]) => values && values.usedAt === null);
		expect(release).toBeDefined();
	});

	test('does not send mail to an address that was not verified', async () => {
		const { service, reply, emailService } = fixture();
		await service.signup(request(), reply as any);
		expect(emailService.sendEmail.mock.calls.some(([to]) => to === 'someone@example.com')).toBe(false);
	});

	test('escapes the signup reason in the HTML body of the moderator mail only', async () => {
		const { service, reply, emailService } = fixture();
		await service.signup(request(), reply as any);
		const call = emailService.sendEmail.mock.calls.find(([to]) => to === 'moderator@example.com');
		expect(call).toBeDefined();
		const [, , html, text] = call!;
		expect(html).not.toContain('<h2>');
		expect(html).toContain('&lt;h2&gt;');
		expect(text).toContain(REASON);
	});

	test('escapes the signup reason in the moderator mail sent after email verification', async () => {
		const { service, reply, emailService } = fixture();
		await service.signupPending({ ip: '127.0.0.1', body: { code: 'pc' } } as any, reply as any);
		const call = emailService.sendEmail.mock.calls.find(([to]) => to === 'moderator@example.com');
		expect(call).toBeDefined();
		const [, , html, text] = call!;
		expect(html).not.toContain('<h2>');
		expect(html).toContain('&lt;h2&gt;');
		expect(text).toContain(REASON);
	});
});
