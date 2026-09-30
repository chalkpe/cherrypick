/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { MastodonApiServerService } from './MastodonApiServerService.js';
import { MastodonClientService } from './MastodonClientService.js';
import { MastodonConverters } from './MastodonConverters.js';
import { MastodonDataService } from './MastodonDataService.js';
import { MastodonFilterService } from './MastodonFilterService.js';
import { MastodonLogger } from './MastodonLogger.js';
import { MastodonNotificationService } from './MastodonNotificationService.js';
import { MastodonOAuthService } from './MastodonOAuthService.js';
import { MastodonPreferenceService } from './MastodonPreferenceService.js';
import { MastodonPushService } from './MastodonPushService.js';
import { MastodonServerUtilityService } from './MastodonServerUtilityService.js';
import { MastodonStreamingService } from './MastodonStreamingService.js';
import { ApiAccountMastodon } from './endpoints/account.js';
import { ApiAppsMastodon } from './endpoints/apps.js';
import { ApiFilterMastodon } from './endpoints/filter.js';
import { ApiInstanceMastodon } from './endpoints/instance.js';
import { ApiMarkersMastodon } from './endpoints/markers.js';
import { ApiNotificationsMastodon } from './endpoints/notifications.js';
import { ApiPushMastodon } from './endpoints/push.js';
import { ApiSearchMastodon } from './endpoints/search.js';
import { ApiStatusMastodon } from './endpoints/status.js';
import { ApiTimelineMastodon } from './endpoints/timeline.js';

/**
 * Providers of the Mastodon-compatible API, registered in ServerModule.
 */
export const mastodonProviders = [
	MastodonApiServerService,
	MastodonClientService,
	MastodonConverters,
	MastodonDataService,
	MastodonFilterService,
	MastodonLogger,
	MastodonNotificationService,
	MastodonOAuthService,
	MastodonPreferenceService,
	MastodonPushService,
	MastodonServerUtilityService,
	MastodonStreamingService,
	ApiAccountMastodon,
	ApiAppsMastodon,
	ApiFilterMastodon,
	ApiInstanceMastodon,
	ApiMarkersMastodon,
	ApiNotificationsMastodon,
	ApiPushMastodon,
	ApiSearchMastodon,
	ApiStatusMastodon,
	ApiTimelineMastodon,
];
