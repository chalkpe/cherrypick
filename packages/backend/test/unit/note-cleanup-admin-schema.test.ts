/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
vi.mock('../../src/core/RoleService.js', () => ({ RoleService: class {} }));
vi.mock('../../src/core/entities/RoleEntityService.js', () => ({ RoleEntityService: class {} }));
vi.mock('../../src/core/IdService.js', () => ({ IdService: class {} }));
import { meta } from '../../src/server/api/endpoints/admin/show-user.js';
import { notificationRecieveConfig } from '../../src/models/json-schema/user.js';

test('OC7: admin/show-user 응답 스키마에 보호 실패 알림 수신 설정 키가 있다', () => {
	const properties = (meta.res as any).properties.notificationRecieveConfig.properties;
	expect(properties.noteCleanupProtectionFailed).toEqual({ optional: true, ...notificationRecieveConfig });
});
