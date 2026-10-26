<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<SearchMarker path="/settings/accounts" :label="i18n.ts.accounts" :keywords="['accounts']" icon="ti ti-users">
	<div class="_gaps">
		<div class="_buttons">
			<MkButton primary @click="addAccount"><i class="ti ti-plus"></i> {{ i18n.ts.addAccount }}</MkButton>
		</div>

		<template v-for="x in accounts" :key="x.host + '/' + x.id">
			<MkUserCardMini
				v-if="x.user && x.host === host"
				:user="x.user"
				:class="$style.user"
				role="button"
				tabindex="0"
				@click.prevent="showMenu(x.host, x.id, $event)"
				@keydown.enter.prevent="showMenu(x.host, x.id, $event)"
				@keydown.space.prevent="showMenu(x.host, x.id, $event)"
			/>
			<button v-else type="button" class="_button" :class="$style.unknownUser" @click="showMenu(x.host, x.id, $event)">
				<span :class="$style.unknownUserAvatarMock" aria-hidden="true"><i class="ti ti-user"></i></span>
				<span :class="$style.unknownUserInfo">
					<span :class="$style.unknownUserTitle">{{ x.username }}</span>
					<span :class="$style.unknownUserSub">@{{ x.username }}@{{ x.host }}</span>
				</span>
			</button>
		</template>
	</div>
</SearchMarker>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { host } from '@@/js/config.js';
import type { MenuItem } from '@/types/menu.js';
import MkButton from '@/components/MkButton.vue';
import * as os from '@/os.js';
import { switchAccount, removeAccount, login, getAccountWithSigninDialog, getAccountWithSignupDialog, getAccounts } from '@/accounts.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import MkUserCardMini from '@/components/MkUserCardMini.vue';

const accounts = computed(() => getAccounts({ includeOtherServers: true }));

function showMenu(accountHost: string, id: string, ev: MouseEvent | KeyboardEvent) {
	const menu: MenuItem[] = [];

	if (accountHost === host) menu.push({
		text: i18n.ts.switch,
		icon: 'ti ti-switch-horizontal',
		action: () => switchAccount(accountHost, id),
	});
	menu.push({
		text: i18n.ts.remove,
		icon: 'ti ti-trash',
		action: () => removeAccount(accountHost, id),
	});

	os.popupMenu(menu, ev.currentTarget ?? ev.target);
}

function addAccount(ev: PointerEvent) {
	os.popupMenu([{
		text: i18n.ts.existingAccount,
		action: () => { addExistingAccount(); },
	}, {
		text: i18n.ts.createAccount,
		action: () => { createAccount(); },
	}], ev.currentTarget ?? ev.target);
}

function addExistingAccount() {
	getAccountWithSigninDialog().then((res) => {
		if (res != null) {
			os.success();
		}
	});
}

function createAccount() {
	getAccountWithSignupDialog().then((res) => {
		if (res != null) {
			login(res.token);
		}
	});
}

const headerActions = computed(() => []);

const headerTabs = computed(() => []);

definePage(() => ({
	title: i18n.ts.accounts,
	icon: 'ti ti-users',
}));
</script>

<style lang="scss" module>
.user {
	cursor: pointer;
}

.unknownUser {
	display: flex;
	align-items: center;
	text-align: start;
	padding: 16px;
	background: var(--MI_THEME-panel);
	border-radius: 8px;
	font-size: 0.9em;
}

.unknownUserInfo {
	min-width: 0;
}

.unknownUserAvatarMock {
	flex-shrink: 0;
	display: block;
	width: 34px;
	height: 34px;
	line-height: 34px;
	text-align: center;
	font-size: 16px;
	margin-right: 12px;
	background-color: color-mix(in srgb, var(--MI_THEME-fg), transparent 85%);
	color: color-mix(in srgb, var(--MI_THEME-fg), transparent 25%);
	border-radius: 50%;
}

.unknownUserTitle {
	display: block;
	width: 100%;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	line-height: 18px;
}

.unknownUserSub {
	display: block;
	width: 100%;
	font-size: 95%;
	opacity: 0.7;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	line-height: 16px;
}
</style>
