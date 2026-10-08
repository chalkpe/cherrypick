/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { IsNull, LessThanOrEqual } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { RegistrationTicketsRepository, UsedUsernamesRepository, UserPendingsRepository, UserProfilesRepository, UsersRepository, MiRegistrationTicket, MiMeta, UserIpsRepository } from '@/models/_.js';
import type { Config } from '@/config.js';
import { CaptchaService } from '@/core/CaptchaService.js';
import { IdService } from '@/core/IdService.js';
import { SignupService } from '@/core/SignupService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { EmailService } from '@/core/EmailService.js';
import { MiLocalUser } from '@/models/User.js';
import { FastifyReplyError } from '@/misc/fastify-reply-error.js';
import { bindThis } from '@/decorators.js';
import { L_CHARS, secureRndstr } from '@/misc/secure-rndstr.js';
import { RoleService } from '@/core/RoleService.js';
import Logger from '@/logger.js';
import { LoggerService } from '@/core/LoggerService.js';
import { getIpHash } from '@/misc/get-ip-hash.js';
import { SIGNUP_PENDING_EXPIRES_IN } from '@/const.js';
import { RateLimiterService } from './RateLimiterService.js';
import { SigninService } from './SigninService.js';
import type { FindOptionsWhere } from 'typeorm';
import type { FastifyRequest, FastifyReply } from 'fastify';

const SIGNUP_PENDING_ERRORS = {
	noSuchCode: {
		message: 'No such code.',
		code: 'NO_SUCH_CODE',
		id: 'deace71c-8578-4021-b413-c85879600c52',
	},
	expired: {
		message: 'The verification link has expired.',
		code: 'EXPIRED',
		id: 'e20e8e57-4ea8-44c3-8a7f-cf4d7b677ed5',
	},
	resendNotAvailable: {
		message: 'The verification email cannot be resent. Please sign up again.',
		code: 'RESEND_NOT_AVAILABLE',
		id: 'f1882baa-89b6-45a8-8236-4908b3e380de',
	},
	rateLimitExceeded: {
		message: 'Rate limit exceeded. Please try again later.',
		code: 'RATE_LIMIT_EXCEEDED',
		id: 'ec8daf37-1f0e-420b-864b-11804118b874',
	},
};

@Injectable()
export class SignupApiService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.userPendingsRepository)
		private userPendingsRepository: UserPendingsRepository,

		@Inject(DI.usedUsernamesRepository)
		private usedUsernamesRepository: UsedUsernamesRepository,

		@Inject(DI.registrationTicketsRepository)
		private registrationTicketsRepository: RegistrationTicketsRepository,

		@Inject(DI.userIpsRepository)
		private userIpsRepository: UserIpsRepository,

		private userEntityService: UserEntityService,
		private idService: IdService,
		private captchaService: CaptchaService,
		private signupService: SignupService,
		private signinService: SigninService,
		private emailService: EmailService,
		private roleService: RoleService,
		private loggerService: LoggerService,
		private rateLimiterService: RateLimiterService,
	) {
		this.logger = this.loggerService.getLogger('Signup');
	}

	@bindThis
	public async signup(
		request: FastifyRequest<{
			Body: {
				username: string;
				password: string;
				host?: string;
				invitationCode?: string;
				emailAddress?: string;
				reason?: string;
				'hcaptcha-response'?: string;
				'g-recaptcha-response'?: string;
				'turnstile-response'?: string;
				'm-captcha-response'?: string;
				'testcaptcha-response'?: string;
			}
		}>,
		reply: FastifyReply,
	) {
		const body = request.body;

		// Verify *Captcha
		// ただしテスト時はこの機構は障害となるため無効にする
		if (process.env.NODE_ENV !== 'test') {
			if (this.meta.enableHcaptcha && this.meta.hcaptchaSecretKey) {
				await this.captchaService.verifyHcaptcha(this.meta.hcaptchaSecretKey, body['hcaptcha-response']).catch(err => {
					throw new FastifyReplyError(400, err);
				});
			}

			if (this.meta.enableMcaptcha && this.meta.mcaptchaSecretKey && this.meta.mcaptchaSitekey && this.meta.mcaptchaInstanceUrl) {
				await this.captchaService.verifyMcaptcha(this.meta.mcaptchaSecretKey, this.meta.mcaptchaSitekey, this.meta.mcaptchaInstanceUrl, body['m-captcha-response']).catch(err => {
					throw new FastifyReplyError(400, err);
				});
			}

			if (this.meta.enableRecaptcha && this.meta.recaptchaSecretKey) {
				await this.captchaService.verifyRecaptcha(this.meta.recaptchaSecretKey, body['g-recaptcha-response']).catch(err => {
					throw new FastifyReplyError(400, err);
				});
			}

			if (this.meta.enableTurnstile && this.meta.turnstileSecretKey) {
				await this.captchaService.verifyTurnstile(this.meta.turnstileSecretKey, body['turnstile-response']).catch(err => {
					throw new FastifyReplyError(400, err);
				});
			}

			if (this.meta.enableTestcaptcha) {
				await this.captchaService.verifyTestcaptcha(body['testcaptcha-response']).catch(err => {
					throw new FastifyReplyError(400, err);
				});
			}
		}

		const username = body['username'];
		const password = body['password'];
		const host: string | null = process.env.NODE_ENV === 'test' ? (body['host'] ?? null) : null;
		const invitationCode = body['invitationCode'];
		const emailAddress = body['emailAddress'];
		const reason = body['reason'];

		if (this.meta.emailRequiredForSignup) {
			if (emailAddress == null || typeof emailAddress !== 'string') {
				reply.code(400);
				return;
			}

			const res = await this.emailService.validateEmailForAccount(emailAddress);
			if (!res.available) {
				reply.code(400);
				return;
			}
		}

		if (this.meta.approvalRequiredForSignup) {
			if (reason == null || typeof reason !== 'string') {
				reply.code(400);
				return;
			}
		}

		let ticket: MiRegistrationTicket | null = null;

		// テスト時はこの機構は障害となるため無効にする
		if (process.env.NODE_ENV !== 'test' && this.meta.disableRegistration) {
			if (invitationCode == null || typeof invitationCode !== 'string') {
				reply.code(400);
				return;
			}

			// ここでの検証はあくまで早期リジェクトのための事前チェックで、
			// 実際の使用可否は消費直前の claimRegistrationTicket() が担保する
			ticket = await this.registrationTicketsRepository.findOneBy({
				code: invitationCode,
			});

			if (ticket == null || ticket.usedById != null) {
				reply.code(400);
				return;
			}

			if (ticket.expiresAt && ticket.expiresAt < new Date()) {
				reply.code(400);
				return;
			}

			// メアド認証が有効の場合
			if (this.meta.emailRequiredForSignup) {
				// メアド認証済みならエラー
				if (ticket.usedBy) {
					reply.code(400);
					return;
				}

				// 認証しておらず、認証リンクの有効期限内ならエラー
				if (ticket.usedAt && ticket.usedAt.getTime() + SIGNUP_PENDING_EXPIRES_IN > Date.now()) {
					reply.code(400);
					return;
				}
			} else if (ticket.usedAt) {
				reply.code(400);
				return;
			}
		}

		if (this.meta.emailRequiredForSignup) {
			if (await this.usersRepository.exists({ where: { usernameLower: username.toLowerCase(), host: IsNull() } })) {
				throw new FastifyReplyError(400, 'DUPLICATED_USERNAME');
			}

			// Check deleted username duplication
			if (await this.usedUsernamesRepository.exists({ where: { username: username.toLowerCase() } })) {
				throw new FastifyReplyError(400, 'USED_USERNAME');
			}

			const isPreserved = this.meta.preservedUsernames.map(x => x.toLowerCase()).includes(username.toLowerCase());
			if (isPreserved) {
				throw new FastifyReplyError(400, 'DENIED_USERNAME');
			}

			const code = secureRndstr(16, { chars: L_CHARS });

			// Generate hash of password
			const hash = await argon2.hash(password);

			if (ticket && !await this.claimRegistrationTicket(ticket)) {
				reply.code(400);
				return;
			}

			try {
				const pendingUser = await this.userPendingsRepository.insertOne({
					id: this.idService.gen(),
					code,
					email: emailAddress!,
					username: username,
					password: hash,
					reason: reason ?? '',
				});

				this.sendSignupEmail(emailAddress!, code);

				if (ticket) {
					await this.registrationTicketsRepository.update(ticket.id, {
						pendingUserId: pendingUser.id,
					});
				}
			} catch (err) {
				// 確保したコードが無駄に消費されたままになるのを防ぐ
				if (ticket) await this.releaseRegistrationTicket(ticket);
				throw err;
			}

			reply.code(204);
			return;
		} else if (this.meta.approvalRequiredForSignup) {
			const { account } = await this.signupService.signup({
				username, password, host, reason,
			});

			if (emailAddress) {
				this.emailService.sendEmail(emailAddress, 'Approval pending',
					'Congratulations! Your account is now pending approval. You will get notified when you have been accepted.',
					'Congratulations! Your account is now pending approval. You will get notified when you have been accepted.');
			}

			if (ticket) {
				await this.registrationTicketsRepository.update(ticket.id, {
					usedAt: new Date(),
					usedBy: account,
					usedById: account.id,
				});
			}

			if (this.meta.enableIpLogging) {
				this.logIp(request.ip, null, account.id);
			}

			const moderators = await this.roleService.getModerators();

			for (const moderator of moderators) {
				const profile = await this.userProfilesRepository.findOneBy({ userId: moderator.id });

				if (profile?.email) {
					this.emailService.sendEmail(profile.email, 'New user awaiting approval',
						`A new user called ${account.username} is awaiting approval with the following reason: "${reason}"`,
						`A new user called ${account.username} is awaiting approval with the following reason: "${reason}"`);
				}
			}

			reply.code(204);
			return;
		} else {
			if (ticket && !await this.claimRegistrationTicket(ticket)) {
				reply.code(400);
				return;
			}

			try {
				const { account, secret } = await this.signupService.signup({
					username, password, host,
				});

				if (ticket) {
					await this.registrationTicketsRepository.update(ticket.id, {
						usedBy: account,
						usedById: account.id,
					});
				}

				const res = await this.userEntityService.pack(account, account, {
					schema: 'MeDetailed',
					includeSecrets: true,
				});

				return {
					...res,
					token: secret,
				};
			} catch (err) {
				// 確保したコードが無駄に消費されたままになるのを防ぐ
				// (アカウントと紐付け済みの場合は release 側の条件により戻らない)
				if (ticket) await this.releaseRegistrationTicket(ticket);
				throw new FastifyReplyError(400, typeof err === 'string' ? err : (err as Error).toString());
			}
		}
	}

	/**
	 * 招待コードを使用中として確保する
	 *
	 * @returns 確保できた場合は true、既に他のリクエストが消費していた場合は false
	 */
	@bindThis
	private async claimRegistrationTicket(ticket: MiRegistrationTicket): Promise<boolean> {
		const where: FindOptionsWhere<MiRegistrationTicket>[] = [
			{ id: ticket.id, usedById: IsNull(), usedAt: IsNull() },
		];

		// メアド認証が有効の場合、認証されないまま認証リンクの有効期限が切れたコードは再び使用できる
		if (this.meta.emailRequiredForSignup) {
			where.push({
				id: ticket.id,
				usedById: IsNull(),
				usedAt: LessThanOrEqual(new Date(Date.now() - SIGNUP_PENDING_EXPIRES_IN)),
				// pendingUser は usedAt より後に作られるので、usedAt 起点だと pendingUser の有効期限内に再使用できてしまう
				pendingUserId: IsNull(),
			});
		}

		const result = await this.registrationTicketsRepository.update(where, {
			usedAt: new Date(),
		});

		if ((result.affected ?? 0) > 0) return true;

		// 期限切れの pendingUser に紐付いたままのコードは、紐付けを解除してから確保し直す
		if (this.meta.emailRequiredForSignup) {
			const stale = await this.registrationTicketsRepository.findOneBy({
				id: ticket.id,
				usedById: IsNull(),
			});
			if (stale?.pendingUserId != null) {
				const pending = await this.userPendingsRepository.findOneBy({ id: stale.pendingUserId });
				const pendingExpired = pending == null
					|| this.idService.parse(pending.id).date.getTime() + SIGNUP_PENDING_EXPIRES_IN < Date.now();
				if (pendingExpired) {
					const detached = await this.registrationTicketsRepository.update({
						id: stale.id,
						pendingUserId: stale.pendingUserId,
						usedById: IsNull(),
					}, { pendingUserId: null });
					if ((detached.affected ?? 0) === 0) return false;
					if (pending != null) await this.userPendingsRepository.delete({ id: pending.id });
					return this.claimRegistrationTicket(ticket);
				}
			}
		}

		return false;
	}

	/**
	 * {@link claimRegistrationTicket} で確保した招待コードを未使用に戻す
	 *
	 * 既にアカウントと紐付いた (= 消費が確定した) コードは戻さない
	 */
	@bindThis
	private async releaseRegistrationTicket(ticket: MiRegistrationTicket): Promise<void> {
		await this.registrationTicketsRepository.update({
			id: ticket.id,
			usedById: IsNull(),
		}, {
			usedAt: null,
			pendingUserId: null,
		});
	}

	@bindThis
	private sendSignupEmail(emailAddress: string, code: string) {
		const link = `${this.config.url}/signup-complete/${code}`;
		const expiresIn = `${SIGNUP_PENDING_EXPIRES_IN / (1000 * 60 * 60)} hours`;

		this.emailService.sendEmail(emailAddress, 'Signup',
			`To complete signup, please click this link:<br><a href="${link}">${link}</a><br>This link expires in ${expiresIn}.`,
			`To complete signup, please click this link: ${link}\nThis link expires in ${expiresIn}.`);
	}

	/**
	 * 仮登録を新しいコードで作り直し、認証メールを再送信する
	 *
	 * 期限切れの仮登録にも使える。古いコードは無効になる
	 */
	@bindThis
	public async resendSignupPending(request: FastifyRequest<{ Body: { code: string; } }>, reply: FastifyReply) {
		const code = request.body['code'];

		if (typeof code !== 'string') {
			reply.code(400);
			return;
		}

		if (this.config.enableIpRateLimit) {
			const rateLimit = await this.rateLimiterService.limit({ key: 'signupPendingResend', duration: 60 * 60 * 1000, max: 5, minInterval: 60 * 1000 }, getIpHash(request.ip));
			if (rateLimit != null) {
				reply.code(429);
				return { error: SIGNUP_PENDING_ERRORS.rateLimitExceeded };
			}
		}

		const pendingUser = await this.userPendingsRepository.findOneBy({ code });

		if (pendingUser == null) {
			reply.code(400);
			return { error: SIGNUP_PENDING_ERRORS.noSuchCode };
		}

		if (await this.usersRepository.exists({ where: { usernameLower: pendingUser.username.toLowerCase(), host: IsNull() } })) {
			reply.code(400);
			return { error: SIGNUP_PENDING_ERRORS.resendNotAvailable };
		}

		const ticket = await this.registrationTicketsRepository.findOneBy({ pendingUserId: pendingUser.id, usedById: IsNull() });

		// 招待制の場合、招待コードを保持したままの仮登録でなければ再送信できない
		// (期限切れの間に他の人がコードを使った場合など)
		if (this.meta.disableRegistration && (ticket == null || (ticket.expiresAt && ticket.expiresAt < new Date()))) {
			reply.code(400);
			return { error: SIGNUP_PENDING_ERRORS.resendNotAvailable };
		}

		const renewed = await this.userPendingsRepository.insertOne({
			id: this.idService.gen(),
			code: secureRndstr(16, { chars: L_CHARS }),
			email: pendingUser.email,
			username: pendingUser.username,
			password: pendingUser.password,
			reason: pendingUser.reason,
		});

		if (ticket) {
			const result = await this.registrationTicketsRepository.update({
				id: ticket.id,
				pendingUserId: pendingUser.id,
				usedById: IsNull(),
			}, {
				pendingUserId: renewed.id,
				usedAt: new Date(),
			});

			// 確認後に他のリクエストがコードを確保した
			if ((result.affected ?? 0) === 0 && this.meta.disableRegistration) {
				await this.userPendingsRepository.delete({ id: renewed.id });
				reply.code(400);
				return { error: SIGNUP_PENDING_ERRORS.resendNotAvailable };
			}
		}

		await this.userPendingsRepository.delete({ id: pendingUser.id });

		this.sendSignupEmail(renewed.email, renewed.code);

		reply.code(204);
		return;
	}

	@bindThis
	public async signupPending(request: FastifyRequest<{ Body: { code: string; } }>, reply: FastifyReply) {
		const body = request.body;

		const code = body['code'];

		if (typeof code !== 'string') {
			reply.code(400);
			return;
		}

		const pendingUser = await this.userPendingsRepository.findOneBy({ code });

		if (pendingUser == null) {
			reply.code(400);
			return { error: SIGNUP_PENDING_ERRORS.noSuchCode };
		}

		if (this.idService.parse(pendingUser.id).date.getTime() + SIGNUP_PENDING_EXPIRES_IN < Date.now()) {
			reply.code(400);
			return { error: SIGNUP_PENDING_ERRORS.expired };
		}

		try {
			const { account } = await this.signupService.signup({
				username: pendingUser.username,
				passwordHash: pendingUser.password,
				reason: pendingUser.reason,
			});

			this.userPendingsRepository.delete({
				id: pendingUser.id,
			});

			const profile = await this.userProfilesRepository.findOneByOrFail({ userId: account.id });

			await this.userProfilesRepository.update({ userId: profile.userId }, {
				email: pendingUser.email,
				emailVerified: true,
				emailVerifyCode: null,
			});

			const ticket = await this.registrationTicketsRepository.findOneBy({ pendingUserId: pendingUser.id });
			if (ticket) {
				await this.registrationTicketsRepository.update(ticket.id, {
					usedBy: account,
					usedById: account.id,
					pendingUserId: null,
				});
			}

			// The sign-up request and the confirmation may've come from different addresses: log both
			if (this.meta.enableIpLogging) {
				this.logIp(request.ip, null, account.id);
			}

			if (this.meta.approvalRequiredForSignup) {
				if (pendingUser.email) {
					this.emailService.sendEmail(pendingUser.email, 'Approval pending',
						'Congratulations! Your account is now pending approval. You will get notified when you have been accepted.',
						'Congratulations! Your account is now pending approval. You will get notified when you have been accepted.');
				}

				const moderators = await this.roleService.getModerators();

				for (const moderator of moderators) {
					const profile = await this.userProfilesRepository.findOneBy({ userId: moderator.id });

					if (profile?.email) {
						this.emailService.sendEmail(profile.email, 'New user awaiting approval',
							`A new user called ${pendingUser.username} is awaiting approval with the following reason: "${pendingUser.reason}"`,
							`A new user called ${pendingUser.username} is awaiting approval with the following reason: "${pendingUser.reason}"`);
					}
				}

				return { pendingApproval: true };
			}

			return this.signinService.signin(request, reply, account as MiLocalUser);
		} catch (err) {
			throw new FastifyReplyError(400, typeof err === 'string' ? err : (err as Error).toString());
		}
	}

	@bindThis
	private logIp(ip: string, ipDate: Date | null, userId: MiLocalUser['id']) {
		try {
			this.userIpsRepository.createQueryBuilder().insert().values({
				createdAt: ipDate ?? new Date(),
				userId,
				ip,
			}).orIgnore(true).execute();
		} catch (err) {
			this.logger.error(err as Error);
		}
	}
}
