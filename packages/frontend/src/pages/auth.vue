<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :actions="headerActions" :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 500px;">
		<div v-if="state == 'fetch-session-error'">
			<p>{{ i18n.ts.somethingHappened }}</p>
		</div>
		<div v-else-if="$i && !session">
			<MkLoading/>
		</div>
		<div v-else-if="$i && session">
			<XForm
				v-if="state == 'waiting'"
				class="form"
				:session="session"
				@denied="denied"
				@accepted="accepted"
			/>
			<div v-if="state == 'denied'">
				<h1>{{ i18n.ts._auth.denied }}</h1>
			</div>
			<div v-if="state == 'accepted' && session">
				<h1>{{ session.app.isAuthorized ? i18n.ts._auth.alreadyAuthorized : i18n.ts._auth.accepted }}</h1>
				<p v-if="session.app.callbackUrl">
					{{ i18n.ts._auth.callback }}
					<MkEllipsis/>
				</p>
				<p v-if="!session.app.callbackUrl">{{ i18n.ts._auth.pleaseGoBack }}</p>
			</div>
		</div>
		<div v-else>
			<p :class="$style.loginMessage">{{ i18n.ts._auth.pleaseLogin }}</p>
			<MkSignin @login="onLogin"/>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { onMounted, ref, computed } from 'vue';
import * as Misskey from 'cherrypick-js';
import XForm from './auth.form.vue';
import MkSignin from '@/components/MkSignin.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { $i } from '@/i.js';
import { definePage } from '@/page.js';
import { i18n } from '@/i18n.js';
import { login } from '@/accounts.js';

const props = defineProps<{
	token: string;
}>();

const state = ref<'waiting' | 'accepted' | 'fetch-session-error' | 'denied' | null>(null);
const session = ref<Misskey.entities.AuthSessionShowResponse | null>(null);

// Keep in sync with FORBIDDEN_REDIRECT_PROTOCOLS in the backend MastodonOAuthService
const MASTODON_FORBIDDEN_REDIRECT_PROTOCOLS = ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'];

// Mastodon-compatible OAuth (/oauth/authorize) sends the user here with these parameters
const mastodonParams = (() => {
	const params = new URLSearchParams(window.location.search);
	if (params.get('mastodon') !== 'true') return null;
	return {
		redirectUri: params.get('redirect_uri'),
		oauthState: params.get('state'),
	};
})();

// Only a URI registered for the app, and never one that runs in this origin, is accepted
function getMastodonRedirectUrl(): URL | null {
	if (session.value == null || mastodonParams == null) return null;

	const registeredUris = (session.value.app.callbackUrl ?? '').split(/\s+/);
	const redirectUri = mastodonParams.redirectUri;
	if (redirectUri == null || !registeredUris.includes(redirectUri) || !URL.canParse(redirectUri)) return null;

	const url = new URL(redirectUri);
	if (MASTODON_FORBIDDEN_REDIRECT_PROTOCOLS.includes(url.protocol)) return null;
	return url;
}

// Returns the result to the Mastodon client. The session token serves as the authorization code.
function redirectToMastodonClient(result: { code: string } | { error: string }) {
	if (mastodonParams == null) return;

	const url = getMastodonRedirectUrl();
	if (url == null) {
		state.value = 'fetch-session-error';
		return;
	}

	for (const [key, value] of Object.entries(result)) {
		url.searchParams.set(key, value);
	}
	if (mastodonParams.oauthState != null) url.searchParams.set('state', mastodonParams.oauthState);
	window.location.href = url.toString();
}

function denied() {
	state.value = 'denied';
	redirectToMastodonClient({ error: 'access_denied' });
}

function accepted() {
	state.value = 'accepted';
	if (session.value && mastodonParams != null) {
		redirectToMastodonClient({ code: session.value.token });
	} else if (session.value && session.value.app.callbackUrl) {
		const url = new URL(session.value.app.callbackUrl);
		if (['javascript:', 'file:', 'data:', 'mailto:', 'tel:', 'vbscript:'].includes(url.protocol)) throw new Error('invalid url');
		window.location.href = `${session.value.app.callbackUrl}?token=${session.value.token}`;
	}
}

function onLogin(res: Misskey.entities.SigninFlowResponse & { finished: true }) {
	login(res.i);
}

onMounted(async () => {
	if (!$i) return;

	try {
		const result = await misskeyApi('auth/session/show', {
			token: props.token,
		});
		session.value = result;

		// Reject a tampered Mastodon redirect before anything is approved
		if (mastodonParams != null && getMastodonRedirectUrl() == null) {
			state.value = 'fetch-session-error';
			return;
		}

		// 既に連携していた場合
		if (result.app.isAuthorized) {
			await misskeyApi('auth/accept', {
				token: result.token,
			});
			accepted();
		} else {
			state.value = 'waiting';
		}
	} catch (err) {
		state.value = 'fetch-session-error';
	}
});

const headerActions = computed(() => []);

const headerTabs = computed(() => []);

definePage(() => ({
	title: i18n.ts._auth.shareAccessTitle,
	icon: 'ti ti-apps',
}));
</script>

<style lang="scss" module>
.loginMessage {
	text-align: center;
	margin: 8px 0 24px;
}
</style>
