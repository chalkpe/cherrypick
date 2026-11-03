<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkModalWindow
	ref="dialogEl"
	:withOkButton="true"
	:okButtonDisabled="selected == null"
	@click="cancel()"
	@close="cancel()"
	@ok="ok()"
	@closed="emit('closed')"
>
	<template #header>{{ i18n.ts.selectUser }}</template>
	<div>
		<div :class="$style.form" class="_gaps">
			<MkInput v-if="computedLocalOnly" v-model="username" :autofocus="true">
				<template #label>{{ i18n.ts.username }}</template>
				<template #prefix>@</template>
			</MkInput>
			<FormSplit v-else :minWidth="170">
				<MkInput v-model="username" :autofocus="true">
					<template #label>{{ i18n.ts.username }}</template>
					<template #prefix>@</template>
				</MkInput>
				<MkInput v-model="host" :datalist="[hostname]">
					<template #label>{{ i18n.ts.host }}</template>
					<template #prefix>@</template>
				</MkInput>
			</FormSplit>
			<MkButton v-if="!computedLocalOnly" :disabled="!canLookup" :wait="lookingUp" @click="lookup">{{ i18n.ts.lookup }}</MkButton>
		</div>
		<div v-if="username != '' || host != ''" :class="[$style.result, { [$style.hit]: users.length > 0 }]">
			<div v-if="users.length > 0" :class="$style.users">
				<button v-for="user in users" :key="user.id" type="button" class="_button" :class="[$style.user, { [$style.selected]: selected && selected.id === user.id }]" :aria-pressed="selected?.id === user.id" @click="selected = user" @dblclick="ok()">
					<MkAvatar :user="user" :class="$style.avatar" indicator :link="false"/>
					<div :class="$style.userBody">
						<MkUserName :user="user" :class="$style.userName"/>
						<MkAcct :user="user" :class="$style.userAcct"/>
					</div>
				</button>
			</div>
			<div v-else :class="$style.empty">
				<span>{{ i18n.ts.noUsers }}</span>
			</div>
		</div>
		<div v-if="username == '' && host == ''" :class="$style.recent">
			<div :class="$style.users">
				<button v-for="user in recentUsers.filter(canSelectUser)" :key="user.id" type="button" class="_button" :class="[$style.user, { [$style.selected]: selected && selected.id === user.id }]" :aria-pressed="selected?.id === user.id" @click="selected = user" @dblclick="ok()">
					<MkAvatar :user="user" :class="$style.avatar" indicator :link="false"/>
					<div :class="$style.userBody">
						<MkUserName :user="user" :class="$style.userName"/>
						<MkAcct :user="user" :class="$style.userAcct"/>
					</div>
				</button>
			</div>
		</div>
	</div>
</MkModalWindow>
</template>

<script lang="ts" setup>
import { onBeforeUnmount, onMounted, ref, computed, useTemplateRef, watch } from 'vue';
import * as Misskey from 'cherrypick-js';
import { host as currentHost, hostname } from '@@/js/config.js';
import MkInput from '@/components/MkInput.vue';
import MkButton from '@/components/MkButton.vue';
import FormSplit from '@/components/form/split.vue';
import MkModalWindow from '@/components/MkModalWindow.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { store } from '@/store.js';
import { i18n } from '@/i18n.js';
import { $i } from '@/i.js';
import { instance } from '@/instance.js';

const emit = defineEmits<{
	(ev: 'ok', selected: Misskey.entities.UserDetailed): void;
	(ev: 'cancel'): void;
	(ev: 'closed'): void;
}>();

const props = withDefaults(defineProps<{
	includeSelf?: boolean;
	localOnly?: boolean;
}>(), {
	includeSelf: false,
	localOnly: false,
});

const computedLocalOnly = computed(() => props.localOnly || instance.federation === 'none');

const username = ref('');
const host = ref('');
const users = ref<Misskey.entities.UserLite[]>([]);
const recentUsers = ref<Misskey.entities.UserDetailed[]>([]);
const selected = ref<Misskey.entities.UserLite | null>(null);
const dialogEl = useTemplateRef('dialogEl');
const lookingUp = ref(false);
let requestId = 0;

const searchQuery = computed(() => {
	const acct = Misskey.acct.parse(username.value.trim());
	const accountHost = acct.host?.toLowerCase();
	if (computedLocalOnly.value && accountHost && accountHost !== hostname && accountHost !== currentHost) return null;
	return {
		username: acct.username,
		host: computedLocalOnly.value ? '.' : accountHost ?? host.value.trim().toLowerCase(),
	};
});
const canLookup = computed(() => !computedLocalOnly.value && !!searchQuery.value?.username && !!searchQuery.value.host && searchQuery.value.host !== '.');

function canSelectUser(user: Misskey.entities.UserLite) {
	return (!computedLocalOnly.value || user.host == null) && (props.includeSelf || user.id !== $i?.id);
}

function search() {
	const currentRequestId = ++requestId;
	selected.value = null;
	users.value = [];
	lookingUp.value = false;
	const query = searchQuery.value;
	if (query == null || (username.value.trim() === '' && host.value.trim() === '')) return;

	misskeyApi('users/search-by-username-and-host', {
		...query,
		limit: 10,
		detail: false,
	}).then(_users => {
		if (currentRequestId === requestId) users.value = _users.filter(canSelectUser);
	}).catch(() => {
		if (currentRequestId === requestId) users.value = [];
	});
}

async function lookup() {
	const query = searchQuery.value;
	if (!canLookup.value || lookingUp.value || query == null) return;
	const currentRequestId = ++requestId;
	selected.value = null;
	users.value = [];
	lookingUp.value = true;
	try {
		const user = await misskeyApi('users/show', query);
		if (currentRequestId === requestId) users.value = [user].filter(canSelectUser);
	} catch {
		if (currentRequestId === requestId) users.value = [];
	} finally {
		if (currentRequestId === requestId) lookingUp.value = false;
	}
}

watch([username, host, computedLocalOnly, () => props.includeSelf], search, { flush: 'sync' });
onBeforeUnmount(() => { requestId++; });

async function ok() {
	if (selected.value == null) return;
	const selectedId = selected.value.id;
	const currentRequestId = requestId;

	const user = await misskeyApi('users/show', {
		userId: selectedId,
	});
	if (currentRequestId !== requestId || selected.value?.id !== selectedId) return;
	emit('ok', user);

	dialogEl.value?.close();

	// 最近使ったユーザー更新
	let recents = store.s.recentlyUsedUsers;
	recents = recents.filter(x => x !== selectedId);
	recents.unshift(selectedId);
	store.set('recentlyUsedUsers', recents.splice(0, 16));
}

function cancel() {
	emit('cancel');
	dialogEl.value?.close();
}

onMounted(() => {
	misskeyApi('users/show', {
		userIds: store.s.recentlyUsedUsers,
	}).then(foundUsers => {
		recentUsers.value = foundUsers;
	});
});
</script>

<style lang="scss" module>
.form {
	padding: calc(var(--root-margin) / 2) var(--root-margin);
}

.result,
.recent {
	display: flex;
	flex-direction: column;
	overflow: auto;
	height: 100%;

	&.result.hit {
		padding: 0;
	}

	&.recent {
		padding: 0;
	}
}

.users {
	flex: 1;
	overflow: auto;
	padding: 8px 0;
}

.user {
	display: flex;
	align-items: center;
	width: 100%;
	text-align: left;
	padding: 8px var(--root-margin);
	font-size: 14px;

	&:hover {
		background: light-dark(rgba(0, 0, 0, 0.05), rgba(255, 255, 255, 0.05));
	}

	&.selected {
		background: var(--MI_THEME-accent);
		color: #fff;
	}
}

.userBody {
	padding: 0 8px;
	min-width: 0;
}

.avatar {
	width: 45px;
	height: 45px;
}

.userName {
	display: block;
	font-weight: bold;
}

.userAcct {
	opacity: 0.5;
}

.empty {
	opacity: 0.7;
	text-align: center;
	padding: 16px;
}
</style>
