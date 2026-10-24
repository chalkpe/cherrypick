/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Misskey 2026.10.0 DB를 이 포크의 마이그레이션 체계로 옮기는 일회성 브리지.
//
// 포크 전용 마이그레이션은 예전 CherryPick 스키마를 전제로 작성되어 있어서 Misskey DB에 그대로 실행하면 실패한다.
// (예: Event1681429921400 이 이미 없어진 "user"."isRoot" 컬럼에 COMMENT를 단다)
// 그래서 Misskey 2026.10.0 스키마와 포크 스키마(ChocoChannelColor1792217918286 시점)의 차이를 한 트랜잭션으로 적용하고,
// 그 사이 포크 전용 마이그레이션을 실행된 것으로 기록한다. 이후 마이그레이션은 평소대로 typeorm migration:run이 실행한다.
//
// Misskey DB가 감지되면 CHERRYPICK_MIGRATION_FROM_MISSKEY=1 일 때만 옮긴다. 옮긴 뒤에는 Misskey로 되돌릴 수 없으니 백업 후 실행할 것.

import dataSource from '../ormconfig.js';

const MISSKEY_HEAD = 'HashtagTableDefaults1784899839024'; // Misskey 2026.10.0

// 브리지가 효과를 대신 적용하는 포크 전용 마이그레이션 (타임스탬프 순)
const BRIDGED_MIGRATIONS = [
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

// Misskey 2026.10.0 이후 추가되었지만 브리지보다 타임스탬프가 오래된 업스트림 마이그레이션.
// 브리지 DDL에 포함되지 않으므로 실행 기록을 넣지 않고 TypeORM이 직접 실행하도록 남겨 둔다.
const PENDING_UPSTREAM_MIGRATIONS = [
	'AutoArchiveAnnouncements1783913268595',
	'UserProfilePasswordComment1790477603333',
	'FollowApprovalByAccountAge1791109435844',
];

// Misskey 2026.10.0 DB에서 check-migrations(스키마 빌더)가 내놓은 DDL을 바탕으로 하고, 기존 행의 값이 필요한 곳만 손봤다
const BRIDGE_QUERIES = [
	'DROP INDEX "public"."IDX_20e30aa35180e317e133d75316"',
	'CREATE TYPE "public"."abuse_report_resolver_expiresat_enum" AS ENUM(\'1hour\', \'12hours\', \'1day\', \'1week\', \'1month\', \'3months\', \'6months\', \'1year\', \'indefinitely\')',
	'CREATE TABLE "abuse_report_resolver" ("id" character varying(32) NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "name" character varying(256) NOT NULL, "targetUserPattern" character varying(1024), "reporterPattern" character varying(1024), "reportContentPattern" character varying(1024), "expirationDate" TIMESTAMP WITH TIME ZONE, "expiresAt" "public"."abuse_report_resolver_expiresat_enum" NOT NULL, "forward" boolean NOT NULL, CONSTRAINT "PK_093500bf1bb38880d38b1bb41dc" PRIMARY KEY ("id")); COMMENT ON COLUMN "abuse_report_resolver"."updatedAt" IS \'The updated date of the AbuseReportResolver.\'; COMMENT ON COLUMN "abuse_report_resolver"."expirationDate" IS \'The expiration date of the AbuseReportResolver\'',
	'CREATE INDEX "IDX_d90c2c0e555b1eb2e4f19c9ad4" ON "abuse_report_resolver" ("updatedAt")',
	'CREATE INDEX "IDX_e83a32a146021c72ba9bde6675" ON "abuse_report_resolver" ("expirationDate")',
	'CREATE TYPE "public"."event_notevisibility_enum" AS ENUM(\'public\', \'home\', \'followers\', \'specified\')',
	'CREATE TABLE "event" ("noteId" character varying(32) NOT NULL, "start" TIMESTAMP WITH TIME ZONE NOT NULL, "end" TIMESTAMP WITH TIME ZONE, "title" character varying(128) NOT NULL, "metadata" jsonb NOT NULL DEFAULT \'{"@context":"https://schema.org/","@type":"Event"}\', "noteVisibility" "public"."event_notevisibility_enum" NOT NULL, "userId" character varying(32) NOT NULL, "userHost" character varying(128), CONSTRAINT "PK_2b481f231cd035e84390072bf7b" PRIMARY KEY ("noteId")); COMMENT ON COLUMN "event"."start" IS \'The start time of the event\'; COMMENT ON COLUMN "event"."end" IS \'The end of the event\'; COMMENT ON COLUMN "event"."title" IS \'short name of event\'; COMMENT ON COLUMN "event"."metadata" IS \'metadata object describing the event. Follows https://schema.org/Event\'; COMMENT ON COLUMN "event"."noteVisibility" IS \'[Denormalized]\'; COMMENT ON COLUMN "event"."userId" IS \'[Denormalized]\'; COMMENT ON COLUMN "event"."userHost" IS \'[Denormalized]\'',
	'CREATE INDEX "IDX_785ee5fc1ea38a1b9b38ff88e5" ON "event" ("start")',
	'CREATE INDEX "IDX_01cd2b829e0263917bf570cb67" ON "event" ("userId")',
	'CREATE INDEX "IDX_f6ba57dff679ccbcfe004698ec" ON "event" ("userHost")',
	'CREATE TYPE "public"."note_history_visibility_enum" AS ENUM(\'public\', \'home\', \'followers\', \'specified\')',
	'CREATE TABLE "note_history" ("id" character varying(32) NOT NULL, "noteId" character varying(32) NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "userId" character varying(32) NOT NULL, "fileIds" character varying(32) array NOT NULL DEFAULT \'{}\', "attachedFileTypes" character varying(256) array NOT NULL DEFAULT \'{}\', "emojis" character varying(128) array NOT NULL DEFAULT \'{}\', "text" text, "cw" character varying(512), "poll" jsonb, "event" jsonb, "visibility" "public"."note_history_visibility_enum" NOT NULL, "visibleUserIds" character varying(32) array NOT NULL DEFAULT \'{}\', CONSTRAINT "PK_b8603c8aa42b803c7687e52c2c0" PRIMARY KEY ("id"))',
	'CREATE INDEX "IDX_1e2492ba7582bf830b750a2962" ON "note_history" ("noteId")',
	'CREATE INDEX "IDX_95a9f7f6939a5cd4ec5d84979a" ON "note_history" ("userId")',
	'ALTER TABLE "user_group" DROP COLUMN "createdAt"',
	'ALTER TABLE "user_group_joining" DROP COLUMN "createdAt"',
	'ALTER TABLE "user_group_invitation" DROP COLUMN "createdAt"',
	// DeleteCreatedAt1697737204579과 같다. 엔티티가 없는 테이블이라 스키마 빌더 결과에서 빠져 있다
	// MigrateMessagingToChat1742927188000은 따라 하지 않는다. Misskey 13 이후 보이지 않던 옛 메시지를 채팅으로 되살리지 않기 위해
	'DROP INDEX "public"."IDX_e21cd3646e52ef9c94aaf17c2e"',
	'ALTER TABLE "messaging_message" DROP COLUMN "createdAt"',
	'ALTER TABLE "user_group_invite" DROP COLUMN "createdAt"',
	'ALTER TABLE "user" ADD "setFederationAvatarShape" boolean',
	'ALTER TABLE "user" ADD "isSquareAvatars" boolean',
	'ALTER TABLE "user" ADD "autoDeleteNotesAfterDays" integer',
	'ALTER TABLE "user" ADD "autoDeleteKeepFavorites" boolean NOT NULL DEFAULT true',
	// AddUserCanChat1762447519068과 같이 기존 유저는 채팅 가능으로 두고, Sync2026091Schema1790412025498과 같이 기본값은 없앤다
	'ALTER TABLE "user" ADD "canChat" boolean DEFAULT true',
	'ALTER TABLE "user" ALTER COLUMN "canChat" DROP DEFAULT',
	'ALTER TABLE "user" ADD "approved" boolean NOT NULL DEFAULT false',
	// 이미 쓰고 있던 계정은 승인된 것으로 본다. 나중에 가입 승인제를 켜도 기존 유저가 로그인하지 못하는 일이 없도록
	'UPDATE "user" SET "approved" = true',
	'ALTER TABLE "user" ADD "signupReason" character varying(1000)',
	'ALTER TABLE "meta" ADD "youBlockedImageUrl" character varying(1024)',
	'ALTER TABLE "meta" ADD "translatorType" character varying(1024)',
	// multipleTranslationServices1660183643857과 같다
	'UPDATE "meta" SET "translatorType" = \'deepl\' WHERE "deeplAuthKey" IS NOT NULL',
	'ALTER TABLE "meta" ADD "ctav3SaKey" character varying(5120)',
	'ALTER TABLE "meta" ADD "ctav3ProjectId" character varying(1024)',
	'ALTER TABLE "meta" ADD "ctav3Location" character varying(1024)',
	'ALTER TABLE "meta" ADD "ctav3Model" character varying(1024)',
	'ALTER TABLE "meta" ADD "ctav3Glossary" character varying(1024)',
	'ALTER TABLE "meta" ADD "libreTranslateEndPoint" character varying(1024)',
	'ALTER TABLE "meta" ADD "libreTranslateApiKey" character varying(1024)',
	'ALTER TABLE "meta" ADD "useRemoteObjectStorage" boolean NOT NULL DEFAULT false',
	'ALTER TABLE "meta" ADD "remoteObjectStorageBucket" character varying(1024)',
	'ALTER TABLE "meta" ADD "remoteObjectStoragePrefix" character varying(1024)',
	'ALTER TABLE "meta" ADD "remoteObjectStorageBaseUrl" character varying(1024)',
	'ALTER TABLE "meta" ADD "remoteObjectStorageEndpoint" character varying(1024)',
	'ALTER TABLE "meta" ADD "remoteObjectStorageRegion" character varying(1024)',
	'ALTER TABLE "meta" ADD "remoteObjectStorageAccessKey" character varying(1024)',
	'ALTER TABLE "meta" ADD "remoteObjectStorageSecretKey" character varying(1024)',
	'ALTER TABLE "meta" ADD "remoteObjectStoragePort" integer',
	'ALTER TABLE "meta" ADD "remoteObjectStorageUseSSL" boolean NOT NULL DEFAULT true',
	'ALTER TABLE "meta" ADD "remoteObjectStorageUseProxy" boolean NOT NULL DEFAULT true',
	'ALTER TABLE "meta" ADD "remoteObjectStorageSetPublicRead" boolean NOT NULL DEFAULT false',
	'ALTER TABLE "meta" ADD "remoteObjectStorageS3ForcePathStyle" boolean NOT NULL DEFAULT true',
	'ALTER TABLE "meta" ADD "trustedLinkUrlPatterns" character varying(3072) array NOT NULL DEFAULT \'{}\'',
	'COMMENT ON COLUMN "meta"."trustedLinkUrlPatterns" IS \'An array of URL strings or regex that can be used to omit warnings about redirects to external sites. Separate them with spaces to specify AND, and enclose them with slashes to specify regular expressions. Each item is regarded as an OR.\'',
	'ALTER TABLE "meta" ADD "doNotSendNotificationEmailsForAbuseReport" boolean NOT NULL DEFAULT false',
	'ALTER TABLE "meta" ADD "emailToReceiveAbuseReport" character varying(1024)',
	'ALTER TABLE "meta" ADD "enableReceivePrerelease" boolean NOT NULL DEFAULT false',
	'ALTER TABLE "meta" ADD "skipVersion" boolean NOT NULL DEFAULT false',
	'ALTER TABLE "meta" ADD "skipCherryPickVersion" character varying(32)',
	'ALTER TABLE "meta" ADD "customSplashText" character varying(1024) array NOT NULL DEFAULT \'{}\'',
	'ALTER TABLE "meta" ADD "disableRegistrationWhenInactive" boolean NOT NULL DEFAULT true',
	'ALTER TABLE "meta" ADD "disablePublicNoteWhenInactive" boolean NOT NULL DEFAULT false',
	'ALTER TABLE "meta" ADD "moderatorInactivityLimitDays" integer NOT NULL DEFAULT \'7\'',
	'ALTER TABLE "meta" ADD "bubbleInstances" character varying(256) array NOT NULL DEFAULT \'{}\'',
	'ALTER TABLE "meta" ADD "customRobotsTxt" character varying(2048)',
	'ALTER TABLE "meta" ADD "approvalRequiredForSignup" boolean NOT NULL DEFAULT false',
	'ALTER TABLE "user_profile" ADD "bridgeHomeVisibility" boolean NOT NULL DEFAULT false',
	'ALTER TABLE "user_profile" ADD "noteVisibilityLimit" character varying(16) NOT NULL DEFAULT \'none\'',
	'ALTER TABLE "antenna" ADD "userGroupJoiningId" character varying(32)',
	'ALTER TABLE "avatar_decoration" ADD "remoteId" character varying(32)',
	'ALTER TABLE "avatar_decoration" ADD "host" character varying(128)',
	'ALTER TABLE "avatar_decoration" ADD "rawUrl" text',
	'ALTER TABLE "chat_message" ADD "emojis" character varying(128) array NOT NULL DEFAULT \'{}\'',
	'ALTER TABLE "note" ADD "updatedAt" TIMESTAMP WITH TIME ZONE',
	'ALTER TABLE "note" ADD "updatedAtHistory" TIMESTAMP WITH TIME ZONE array',
	'ALTER TABLE "note" ADD "deleteAt" TIMESTAMP WITH TIME ZONE',
	// AddDeliveryTargets1751828594933과 같이 기존 행은 NULL(전달 대상 지정 없음)로 두고, Sync2026091Schema1790412025498과 같이 기본값만 바꾼다
	'ALTER TABLE "note" ADD "deliveryTargets" jsonb',
	'ALTER TABLE "note" ALTER COLUMN "deliveryTargets" SET DEFAULT \'{}\'',
	'ALTER TABLE "note" ADD "hasEvent" boolean NOT NULL DEFAULT false',
	'ALTER TABLE "note" ADD "disableRightClick" boolean NOT NULL DEFAULT false',
	'ALTER TABLE "instance" ADD "quarantineLimited" boolean NOT NULL DEFAULT false',
	'ALTER TABLE "instance" ADD "supportsAvatarDecorations" boolean NOT NULL DEFAULT false',
	'COMMENT ON COLUMN "instance"."supportsAvatarDecorations" IS \'Whether the Instance advertises avatar decorations in its NodeInfo.\'',
	'ALTER TABLE "note_draft" ADD "hasEvent" boolean NOT NULL DEFAULT false',
	'ALTER TABLE "note_draft" ADD "disableRightClick" boolean NOT NULL DEFAULT false',
	'ALTER TABLE "note_draft" ADD "eventStart" TIMESTAMP WITH TIME ZONE',
	'COMMENT ON COLUMN "note_draft"."eventStart" IS \'The start time of the event\'',
	'ALTER TABLE "note_draft" ADD "eventEnd" TIMESTAMP WITH TIME ZONE',
	'COMMENT ON COLUMN "note_draft"."eventEnd" IS \'The end of the event\'',
	'ALTER TABLE "note_draft" ADD "eventTitle" character varying(128)',
	'COMMENT ON COLUMN "note_draft"."eventTitle" IS \'short name of event\'',
	'ALTER TABLE "note_draft" ADD "eventMetadata" jsonb NOT NULL DEFAULT \'{"@context":"https://schema.org/","@type":"Event"}\'',
	'COMMENT ON COLUMN "note_draft"."eventMetadata" IS \'metadata object describing the event. Follows https://schema.org/Event\'',
	'ALTER TABLE "note_draft" ADD "deleteAt" TIMESTAMP WITH TIME ZONE',
	'ALTER TABLE "note_draft" ADD "deliveryTargets" jsonb',
	'ALTER TABLE "note_draft" ALTER COLUMN "deliveryTargets" SET DEFAULT \'{}\'',
	'ALTER TABLE "user_ip" ADD "dnsNames" character varying(512) array NOT NULL DEFAULT \'{}\'',
	// ApprovalSignup1768893580518, Sync2026091Schema1790412025498과 같다
	'ALTER TABLE "user_pending" ADD "reason" character varying(1000)',
	'UPDATE "user_pending" SET "reason" = \'\' WHERE "reason" IS NULL',
	'ALTER TABLE "user_pending" ALTER COLUMN "reason" SET NOT NULL',
	'ALTER TABLE "__chart__federation" ADD "___software" smallint NOT NULL DEFAULT \'0\'',
	'ALTER TABLE "__chart_day__federation" ADD "___software" smallint NOT NULL DEFAULT \'0\'',
	'ALTER TABLE "meta" ALTER COLUMN "repositoryUrl" SET DEFAULT \'https://github.com/chalkpe/cherrypick\'',
	'ALTER TABLE "meta" ALTER COLUMN "feedbackUrl" SET DEFAULT \'https://github.com/chalkpe/cherrypick/issues/new/choose\'',
	// UseChalkpeRepositoryUrls1790417182013과 같이 업스트림 기본값이면 포크 저장소를 가리키게 한다
	'UPDATE "meta" SET "repositoryUrl" = \'https://github.com/chalkpe/cherrypick\' WHERE "repositoryUrl" = \'https://github.com/misskey-dev/misskey\'',
	'UPDATE "meta" SET "feedbackUrl" = \'https://github.com/chalkpe/cherrypick/issues/new/choose\' WHERE "feedbackUrl" = \'https://github.com/misskey-dev/misskey/issues/new\'',
	'ALTER TABLE "meta" ALTER COLUMN "preservedUsernames" SET DEFAULT \'{admin,administrator,root,system,maintainer,host,mod,moderator,owner,superuser,staff,auth,i,me,everyone,all,mention,mentions,example,user,users,account,accounts,official,help,helps,support,supports,info,information,informations,announce,announces,announcement,announcements,notice,notification,notifications,dev,developer,developers,tech,misskey,cherrypick}\'',
	'ALTER TABLE "user_profile" ALTER COLUMN "emailNotificationTypes" SET DEFAULT \'["follow","receiveFollowRequest","groupInvited"]\'',
	'ALTER TYPE "public"."antenna_src_enum" ADD VALUE \'group\'',
	'ALTER TABLE "channel" ALTER COLUMN "color" SET DEFAULT \'#eab1b7\'',
	'CREATE INDEX "IDX_72689e25ff8131746cb31ef9a1" ON "note_draft" ("eventStart")',
	'ALTER TABLE "antenna" ADD CONSTRAINT "FK_ccbf5a8c0be4511133dcc50ddeb" FOREIGN KEY ("userGroupJoiningId") REFERENCES "user_group_joining"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
	'ALTER TABLE "event" ADD CONSTRAINT "FK_2b481f231cd035e84390072bf7b" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
	'ALTER TABLE "note_history" ADD CONSTRAINT "FK_1e2492ba7582bf830b750a29627" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
	'ALTER TABLE "note_history" ADD CONSTRAINT "FK_95a9f7f6939a5cd4ec5d84979af" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
];

const timestampOf = name => Number(name.match(/(\d{13})$/)[1]);

async function bridge(queryRunner) {
	const [{ hasTable }] = await queryRunner.query('SELECT to_regclass(\'public.migrations\') IS NOT NULL AS "hasTable"');
	const executed = hasTable
		? (await queryRunner.query('SELECT "name" FROM "migrations" ORDER BY "timestamp"')).map(row => row.name)
		: [];
	const executedSet = new Set(executed);

	// 새 DB이거나 이미 CherryPick 계열인 DB는 건드리지 않는다
	if (executed.length === 0 || BRIDGED_MIGRATIONS.some(name => executedSet.has(name))) {
		return 0;
	}

	const latest = executed.at(-1);
	if (latest !== MISSKEY_HEAD) {
		console.error(`This database looks like Misskey, but only Misskey 2026.10.0 (${MISSKEY_HEAD}) can be migrated to CherryPick. Latest executed migration: ${latest}`);
		return 1;
	}

	if (process.env.CHERRYPICK_MIGRATION_FROM_MISSKEY !== '1') {
		console.error('A Misskey 2026.10.0 database was detected. Back it up, then set CHERRYPICK_MIGRATION_FROM_MISSKEY=1 to migrate it to CherryPick. This cannot be undone.');
		return 1;
	}

	// 알려진 업스트림 마이그레이션 외에는 브리지 목록과 정확히 같아야 한다 (알 수 없는 스키마 변경은 거부한다)
	const bridgeHead = timestampOf(BRIDGED_MIGRATIONS.at(-1));
	const pending = dataSource.migrations
		.map(migration => migration.name ?? migration.constructor.name)
		.filter(name => !executedSet.has(name) && timestampOf(name) <= bridgeHead);
	const unexpected = pending.filter(name => !BRIDGED_MIGRATIONS.includes(name) && !PENDING_UPSTREAM_MIGRATIONS.includes(name));
	const missing = BRIDGED_MIGRATIONS.filter(name => !pending.includes(name));
	if (unexpected.length > 0 || missing.length > 0) {
		console.error('Pending migrations do not match the bridge. Update scripts/bridge_from_misskey.js.');
		console.error(`Unexpected: ${unexpected.join(', ') || '-'}`);
		console.error(`Missing: ${missing.join(', ') || '-'}`);
		return 1;
	}

	console.log('Migrating Misskey 2026.10.0 database to CherryPick...');
	await queryRunner.startTransaction();
	try {
		for (const query of BRIDGE_QUERIES) {
			await queryRunner.query(query);
		}
		for (const name of BRIDGED_MIGRATIONS) {
			await queryRunner.query('INSERT INTO "migrations" ("timestamp", "name") VALUES ($1, $2)', [timestampOf(name), name]);
		}
		await queryRunner.commitTransaction();
	} catch (err) {
		await queryRunner.rollbackTransaction();
		throw err;
	}
	console.log(`Migrated. Marked ${BRIDGED_MIGRATIONS.length} CherryPick migrations as executed.`);
	return 0;
}

await dataSource.initialize();
const queryRunner = dataSource.createQueryRunner();

try {
	process.exitCode = await bridge(queryRunner);
} finally {
	await queryRunner.release();
	await dataSource.destroy();
}
