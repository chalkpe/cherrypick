/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class Sync2026091Schema1790412025498 {
    name = 'Sync2026091Schema1790412025498'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "poll_vote" DROP CONSTRAINT "FK_poll_vote_poll"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_note_deliveryTargets"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2cd3b2a6b4cf0b910b260afe08"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_renote_muting_muteeId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_renote_muting_muterId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_note_draft_deliveryTargets"`);
        await queryRunner.query(`ALTER TABLE "user" ALTER COLUMN "canChat" DROP DEFAULT`);
        await queryRunner.query(`UPDATE "meta" SET "remoteObjectStorageUseSSL" = true WHERE "remoteObjectStorageUseSSL" IS NULL`);
        await queryRunner.query(`UPDATE "meta" SET "remoteObjectStorageUseProxy" = true WHERE "remoteObjectStorageUseProxy" IS NULL`);
        await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "remoteObjectStorageUseSSL" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "remoteObjectStorageUseProxy" SET NOT NULL`);
        await queryRunner.query(`COMMENT ON COLUMN "meta"."trustedLinkUrlPatterns" IS 'An array of URL strings or regex that can be used to omit warnings about redirects to external sites. Separate them with spaces to specify AND, and enclose them with slashes to specify regular expressions. Each item is regarded as an OR.'`);
        await queryRunner.query(`COMMENT ON COLUMN "abuse_report_resolver"."updatedAt" IS 'The updated date of the AbuseReportResolver.'`);
        await queryRunner.query(`COMMENT ON COLUMN "abuse_report_resolver"."expirationDate" IS 'The expiration date of the AbuseReportResolver'`);
        await queryRunner.query(`ALTER TABLE "user_profile" DROP CONSTRAINT "FK_51cb79b5555effaf7d69ba1cff9"`);
        await queryRunner.query(`ALTER TABLE "abuse_report_notification_recipient" DROP CONSTRAINT "FK_abuse_report_notification_recipient_userId2"`);
        await queryRunner.query(`ALTER TABLE "user_profile" DROP CONSTRAINT "UQ_51cb79b5555effaf7d69ba1cff9"`);
        await queryRunner.query(`ALTER TABLE "channel" ALTER COLUMN "color" SET DEFAULT '#ffbcdc'`);
        await queryRunner.query(`ALTER TABLE "note" ALTER COLUMN "deliveryTargets" SET DEFAULT '{}'`);
        await queryRunner.query(`COMMENT ON COLUMN "event"."metadata" IS 'metadata object describing the event. Follows https://schema.org/Event'`);
        await queryRunner.query(`ALTER TABLE "event" ALTER COLUMN "metadata" SET DEFAULT '{"@context":"https://schema.org/","@type":"Event"}'`);
        await queryRunner.query(`UPDATE "note_draft" SET "hasEvent" = false WHERE "hasEvent" IS NULL`);
        await queryRunner.query(`UPDATE "note_draft" SET "disableRightClick" = false WHERE "disableRightClick" IS NULL`);
        await queryRunner.query(`UPDATE "note_draft" SET "eventMetadata" = '{"@context":"https://schema.org/","@type":"Event"}'::jsonb WHERE "eventMetadata" IS NULL`);
        await queryRunner.query(`ALTER TABLE "note_draft" ALTER COLUMN "hasEvent" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "note_draft" ALTER COLUMN "disableRightClick" SET NOT NULL`);
        await queryRunner.query(`COMMENT ON COLUMN "note_draft"."eventStart" IS 'The start time of the event'`);
        await queryRunner.query(`COMMENT ON COLUMN "note_draft"."eventEnd" IS 'The end of the event'`);
        await queryRunner.query(`COMMENT ON COLUMN "note_draft"."eventTitle" IS 'short name of event'`);
        await queryRunner.query(`ALTER TABLE "note_draft" ALTER COLUMN "eventMetadata" SET NOT NULL`);
        await queryRunner.query(`COMMENT ON COLUMN "note_draft"."eventMetadata" IS 'metadata object describing the event. Follows https://schema.org/Event'`);
        await queryRunner.query(`ALTER TABLE "note_draft" ALTER COLUMN "eventMetadata" SET DEFAULT '{"@context":"https://schema.org/","@type":"Event"}'`);
        await queryRunner.query(`ALTER TABLE "note_draft" ALTER COLUMN "deliveryTargets" SET DEFAULT '{}'`);
        await queryRunner.query(`ALTER TABLE "poll" DROP CONSTRAINT "FK_da851e06d0dfe2ef397d8b1bf1b"`);
        await queryRunner.query(`ALTER TABLE "poll" DROP CONSTRAINT "UQ_da851e06d0dfe2ef397d8b1bf1b"`);
        await queryRunner.query(`ALTER TABLE "promo_note" DROP CONSTRAINT "FK_e263909ca4fe5d57f8d4230dd5c"`);
        await queryRunner.query(`ALTER TABLE "promo_note" DROP CONSTRAINT "UQ_e263909ca4fe5d57f8d4230dd5c"`);
        await queryRunner.query(`ALTER TABLE "user_keypair" DROP CONSTRAINT "FK_f4853eb41ab722fe05f81cedeb6"`);
        await queryRunner.query(`ALTER TABLE "user_keypair" DROP CONSTRAINT "UQ_f4853eb41ab722fe05f81cedeb6"`);
        await queryRunner.query(`UPDATE "user_pending" SET "reason" = '' WHERE "reason" IS NULL`);
        await queryRunner.query(`ALTER TABLE "user_pending" ALTER COLUMN "reason" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "user_publickey" DROP CONSTRAINT "FK_10c146e4b39b443ede016f6736d"`);
        await queryRunner.query(`ALTER TABLE "user_publickey" DROP CONSTRAINT "UQ_10c146e4b39b443ede016f6736d"`);
        await queryRunner.query(`CREATE INDEX "IDX_3fcc2c589eaefc205e0714b99c" ON "ad"  ("startsAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c71faf11f0a28a5c0bb506203c" ON "channel_favorite"  ("userId", "channelId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f7b9d338207e40e768e4a5265a" ON "instance"  ("firstRetrievedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_72689e25ff8131746cb31ef9a1" ON "note_draft"  ("eventStart") `);
        await queryRunner.query(`CREATE INDEX "IDX_7eac97594bcac5ffcf2068089b" ON "renote_muting"  ("muteeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_7aa72a5fe76019bfe8e5e0e8b7" ON "renote_muting"  ("muterId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0d801c609cec4e9eb4b6b4490c" ON "renote_muting"  ("muterId", "muteeId") `);
        await queryRunner.query(`ALTER TABLE "user_profile" ADD CONSTRAINT "FK_51cb79b5555effaf7d69ba1cff9" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "abuse_report_notification_recipient" ADD CONSTRAINT "FK_abuse_report_notification_recipient_userId2" FOREIGN KEY ("userId") REFERENCES "user_profile"("userId") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "poll" ADD CONSTRAINT "FK_da851e06d0dfe2ef397d8b1bf1b" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "promo_note" ADD CONSTRAINT "FK_e263909ca4fe5d57f8d4230dd5c" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "renote_muting" ADD CONSTRAINT "FK_7eac97594bcac5ffcf2068089b6" FOREIGN KEY ("muteeId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "renote_muting" ADD CONSTRAINT "FK_7aa72a5fe76019bfe8e5e0e8b7d" FOREIGN KEY ("muterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_keypair" ADD CONSTRAINT "FK_f4853eb41ab722fe05f81cedeb6" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_publickey" ADD CONSTRAINT "FK_10c146e4b39b443ede016f6736d" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "user_publickey" DROP CONSTRAINT "FK_10c146e4b39b443ede016f6736d"`);
        await queryRunner.query(`ALTER TABLE "user_keypair" DROP CONSTRAINT "FK_f4853eb41ab722fe05f81cedeb6"`);
        await queryRunner.query(`ALTER TABLE "renote_muting" DROP CONSTRAINT "FK_7aa72a5fe76019bfe8e5e0e8b7d"`);
        await queryRunner.query(`ALTER TABLE "renote_muting" DROP CONSTRAINT "FK_7eac97594bcac5ffcf2068089b6"`);
        await queryRunner.query(`ALTER TABLE "promo_note" DROP CONSTRAINT "FK_e263909ca4fe5d57f8d4230dd5c"`);
        await queryRunner.query(`ALTER TABLE "poll" DROP CONSTRAINT "FK_da851e06d0dfe2ef397d8b1bf1b"`);
        await queryRunner.query(`ALTER TABLE "abuse_report_notification_recipient" DROP CONSTRAINT "FK_abuse_report_notification_recipient_userId2"`);
        await queryRunner.query(`ALTER TABLE "user_profile" DROP CONSTRAINT "FK_51cb79b5555effaf7d69ba1cff9"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0d801c609cec4e9eb4b6b4490c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7aa72a5fe76019bfe8e5e0e8b7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7eac97594bcac5ffcf2068089b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_72689e25ff8131746cb31ef9a1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f7b9d338207e40e768e4a5265a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c71faf11f0a28a5c0bb506203c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3fcc2c589eaefc205e0714b99c"`);
        await queryRunner.query(`ALTER TABLE "user_publickey" ADD CONSTRAINT "UQ_10c146e4b39b443ede016f6736d" UNIQUE ("userId")`);
        await queryRunner.query(`ALTER TABLE "user_publickey" ADD CONSTRAINT "FK_10c146e4b39b443ede016f6736d" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_pending" ALTER COLUMN "reason" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "user_keypair" ADD CONSTRAINT "UQ_f4853eb41ab722fe05f81cedeb6" UNIQUE ("userId")`);
        await queryRunner.query(`ALTER TABLE "user_keypair" ADD CONSTRAINT "FK_f4853eb41ab722fe05f81cedeb6" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "promo_note" ADD CONSTRAINT "UQ_e263909ca4fe5d57f8d4230dd5c" UNIQUE ("noteId")`);
        await queryRunner.query(`ALTER TABLE "promo_note" ADD CONSTRAINT "FK_e263909ca4fe5d57f8d4230dd5c" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "poll" ADD CONSTRAINT "UQ_da851e06d0dfe2ef397d8b1bf1b" UNIQUE ("noteId")`);
        await queryRunner.query(`ALTER TABLE "poll" ADD CONSTRAINT "FK_da851e06d0dfe2ef397d8b1bf1b" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "note_draft" ALTER COLUMN "deliveryTargets" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "note_draft" ALTER COLUMN "eventMetadata" SET DEFAULT '{}'`);
        await queryRunner.query(`COMMENT ON COLUMN "note_draft"."eventMetadata" IS NULL`);
        await queryRunner.query(`ALTER TABLE "note_draft" ALTER COLUMN "eventMetadata" DROP NOT NULL`);
        await queryRunner.query(`COMMENT ON COLUMN "note_draft"."eventTitle" IS NULL`);
        await queryRunner.query(`COMMENT ON COLUMN "note_draft"."eventEnd" IS NULL`);
        await queryRunner.query(`COMMENT ON COLUMN "note_draft"."eventStart" IS NULL`);
        await queryRunner.query(`ALTER TABLE "note_draft" ALTER COLUMN "disableRightClick" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "note_draft" ALTER COLUMN "hasEvent" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "event" ALTER COLUMN "metadata" SET DEFAULT '{}'`);
        await queryRunner.query(`COMMENT ON COLUMN "event"."metadata" IS 'metadata mapping for event with more user configurable optional information'`);
        await queryRunner.query(`ALTER TABLE "note" ALTER COLUMN "deliveryTargets" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "channel" ALTER COLUMN "color" SET DEFAULT '#86b300'`);
        await queryRunner.query(`ALTER TABLE "user_profile" ADD CONSTRAINT "UQ_51cb79b5555effaf7d69ba1cff9" UNIQUE ("userId")`);
        await queryRunner.query(`ALTER TABLE "abuse_report_notification_recipient" ADD CONSTRAINT "FK_abuse_report_notification_recipient_userId2" FOREIGN KEY ("userId") REFERENCES "user_profile"("userId") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_profile" ADD CONSTRAINT "FK_51cb79b5555effaf7d69ba1cff9" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`COMMENT ON COLUMN "abuse_report_resolver"."expirationDate" IS 'The expiration date of AbuseReportResolver'`);
        await queryRunner.query(`COMMENT ON COLUMN "abuse_report_resolver"."updatedAt" IS 'The updated date of AbuseReportResolver'`);
        await queryRunner.query(`COMMENT ON COLUMN "meta"."trustedLinkUrlPatterns" IS NULL`);
        await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "remoteObjectStorageUseProxy" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "remoteObjectStorageUseSSL" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "user" ALTER COLUMN "canChat" SET DEFAULT true`);
        await queryRunner.query(`CREATE INDEX "IDX_note_draft_deliveryTargets" ON "note_draft" USING gin ("deliveryTargets") `);
        await queryRunner.query(`CREATE INDEX "IDX_renote_muting_muterId" ON "muting" USING btree ("muterId") `);
        await queryRunner.query(`CREATE INDEX "IDX_renote_muting_muteeId" ON "muting" USING btree ("muteeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_2cd3b2a6b4cf0b910b260afe08" ON "instance" USING btree ("firstRetrievedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_note_deliveryTargets" ON "note" USING gin ("deliveryTargets") `);
        await queryRunner.query(`ALTER TABLE "poll_vote" ADD CONSTRAINT "FK_poll_vote_poll" FOREIGN KEY ("noteId") REFERENCES "poll"("noteId") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }
}
