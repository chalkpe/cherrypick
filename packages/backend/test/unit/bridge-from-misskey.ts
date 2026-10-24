/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const MISSKEY_HEAD = 'HashtagTableDefaults1784899839024';
// The fork migrations represented by the fixed Misskey 2026.10.0 bridge schema.
const FORK_MIGRATIONS = [
	'disableRightClick1629387925000',
	'increaseSmtpCharLimit1654589815249',
	'multipleTranslationServices1660183643857',
	'Event1681429921400',
	'Event1681673280586',
	'Event1681675881633',
	'tweakVarcharLength21684231006000',
	'MultipleTranslationServices1685378242713',
	'AbuseReportResolver1686908762393',
	'ObjectStorageRemoteSetting1689580926821',
	'NotificationEmailsForAbuseReport1691120548582',
	'NoteEditHistory1696044626209',
	'NoteUpdateAtHistory1696318192428',
	'AddMetaOptions1696402675000',
	'AddMetaOptions1696417300000',
	'PollVotePoll1696604572677',
	'DeleteCreatedAt1697737204579',
	'RemoteAvaterDecoration1699432324194',
	'ScheduleNote1699437894737',
	'BubbleInstances1701647674000',
	'NoteUpdatedAt1704185628000',
	'ExternalWebsiteWarn1711008460816',
	'NoRecursiveDelete1711722198590',
	'AddDeleteAt1720161864577',
	'AddCustomSplash1723982389378',
	'NoteHistory1725344700039',
	'NoteHistory2_1725517326637',
	'RemoteObjectStorage1729518620697',
	'DropObjectStorageRemoteSetting1730162520000',
	'YouBlockedImageUrl1730364663000',
	'checkModeratorInactive1731385181000',
	'checkModeratorInactive21732593870000',
	'LibreTranslate1734793052000',
	'customRobotsTxt1738098171990',
	'setFederationAvatarShape1738776889000',
	'AddAvatarRawUrl1739785206096',
	'MigrateMessagingToChat1742927188000',
	'UserIpsAddDnsNames1746361416550',
	'AddDeliveryTargets1751828594933',
	'DropScheduleNote1760797772000',
	'AddAutoDeleteNoteSettings1761287521000',
	'RemoveNoteEditHistory1761583921158',
	'NoteHistoryAddCwPollEvent1761584610791',
	'chartFederationSoftware1761595707656',
	'AddChatMessageEmojis1762351977309',
	'AddUserCanChat1762447519068',
	'AddInstanceQuarantineLimited1762797644990',
	'ApprovalSignup1768893580518',
	'Sync2026091Schema1790412025498',
	'UseChalkpeRepositoryUrls1790417182013',
	'BridgeHomeVisibility1790689727413',
	'NoteHistoryUserIdIndex1790794611423',
	'AddSupportsAvatarDecorationsToInstance1790853820624',
	'UseFeedbackIssueChooser1791524666758',
	'NoteVisibilityLimit1791616853956',
	'ChocoChannelColor1792217918286',
];
const NEW_UPSTREAM_MIGRATIONS = [
	'AutoArchiveAnnouncements1783913268595',
	'UserProfilePasswordComment1790477603333',
	'FollowApprovalByAccountAge1791109435844',
];

const database = vi.hoisted(() => ({
	migrations: [] as string[],
	executed: [] as string[],
	statements: [] as string[],
	transactionStarted: false,
	committed: false,
}));

// Replace only the database boundary; import and execute the real bridge script.
vi.mock('../../ormconfig.js', () => ({
	default: {
		get migrations() {
			return database.migrations.map(name => ({ name }));
		},
		initialize: async () => {},
		destroy: async () => {},
		createQueryRunner: () => ({
			query: async (sql: string, params?: [number, string]) => {
				if (sql.startsWith('SELECT to_regclass')) return [{ hasTable: true }];
				if (sql.startsWith('SELECT "name"')) return database.executed.map(name => ({ name }));
				database.statements.push(sql);
				if (sql.startsWith('INSERT INTO "migrations"')) database.executed.push(params![1]);
				return [];
			},
			startTransaction: async () => { database.transactionStarted = true; },
			commitTransaction: async () => { database.committed = true; },
			rollbackTransaction: async () => {},
			release: async () => {},
		}),
	},
}));

describe('Misskey database bridge migration selection', () => {
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		vi.resetModules();
		vi.stubEnv('CHERRYPICK_MIGRATION_FROM_MISSKEY', '1');
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		originalExitCode = process.exitCode;
		database.migrations = [MISSKEY_HEAD, ...FORK_MIGRATIONS];
		database.executed = [MISSKEY_HEAD];
		database.statements = [];
		database.transactionStarted = false;
		database.committed = false;
	});

	afterEach(() => {
		process.exitCode = originalExitCode;
		vi.unstubAllEnvs();
	});

	test('continues to bridge the supported Misskey 2026.10.0 schema', async () => {
		await import('../../scripts/bridge_from_misskey.js');

		expect(process.exitCode).toBe(0);
		expect(database.committed).toBe(true);
		expect(database.executed).toEqual([MISSKEY_HEAD, ...FORK_MIGRATIONS]);
	});

	test('leaves new upstream migrations pending for the normal TypeORM migration runner', async () => {
		database.migrations.push(...NEW_UPSTREAM_MIGRATIONS);

		await import('../../scripts/bridge_from_misskey.js');

		expect(process.exitCode).toBe(0);
		expect(database.committed).toBe(true);
		expect(database.executed).toEqual([MISSKEY_HEAD, ...FORK_MIGRATIONS]);
		expect(database.migrations.filter(name => !database.executed.includes(name))).toEqual(NEW_UPSTREAM_MIGRATIONS);
	});

	test('rejects an unknown migration even if its timestamp matches an allowed upstream migration', async () => {
		database.migrations.push(...NEW_UPSTREAM_MIGRATIONS, 'UnknownMigration1791109435844');

		await import('../../scripts/bridge_from_misskey.js');

		expect(process.exitCode).toBe(1);
		expect(database.transactionStarted).toBe(false);
		expect(database.statements).toEqual([]);
		expect(database.executed).toEqual([MISSKEY_HEAD]);
	});

	test('still rejects a missing fork migration before applying any schema changes', async () => {
		database.migrations.pop();
		database.migrations.push(...NEW_UPSTREAM_MIGRATIONS);

		await import('../../scripts/bridge_from_misskey.js');

		expect(process.exitCode).toBe(1);
		expect(database.transactionStarted).toBe(false);
		expect(database.statements).toEqual([]);
		expect(database.executed).toEqual([MISSKEY_HEAD]);
	});
});
