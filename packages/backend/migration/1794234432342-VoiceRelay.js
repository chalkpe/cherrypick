/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export class VoiceRelay1794234432342 {
 name = 'VoiceRelay1794234432342';
 async up(queryRunner) {
  await queryRunner.query('CREATE TABLE "voice_token_generation" (room_id text NOT NULL, identity_digest text NOT NULL, generation uuid NOT NULL, pending boolean NOT NULL DEFAULT false, PRIMARY KEY(room_id,identity_digest))');
  await queryRunner.query('CREATE SCHEMA "voice_relay"');
  await queryRunner.query("CREATE TABLE \"voice_relay\".\"consumer_state\" (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())");
  await queryRunner.query("CREATE INDEX consumer_active_locator ON \"voice_relay\".\"consumer_state\" ((value->>'remoteId'), (value->>'generation')) WHERE key LIKE 'allocation:%' AND value->>'state'='active'");
  await queryRunner.query("CREATE INDEX consumer_live_allocations ON \"voice_relay\".\"consumer_state\" ((value->'provider'->>'id')) WHERE key LIKE 'allocation:%' AND value->>'state'<>'ended'");
  await queryRunner.query("CREATE INDEX consumer_ended_retention ON \"voice_relay\".\"consumer_state\" (updated_at) WHERE value->>'state'='ended' AND (key LIKE 'allocation:%' OR key LIKE 'direct:%')");
 }
 async down(queryRunner) {
  await queryRunner.query('DROP SCHEMA "voice_relay" CASCADE');
  await queryRunner.query('DROP TABLE "voice_token_generation"');
 }
}
