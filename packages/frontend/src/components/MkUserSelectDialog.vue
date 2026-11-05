<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkModalWindow
	ref="dialogEl"
	:withOkButton="true"
	:okButtonDisabled="multiple ? pickedUsers.length === 0 : selected == null"
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
		<div v-if="multiple" :class="$style.picked">
			<div :class="$style.pickedLabel" aria-live="polite">{{ pickedUsers.length > 0 ? i18n.tsx.selectedUsersCount({ n: pickedUsers.length }) : i18n.ts.canSelectMultipleUsers }}</div>
			<ul v-if="pickedUsers.length > 0" :class="$style.pickedUsers">
				<li v-for="user in pickedUsers" :key="user.id" :class="$style.pickedUser">
					<MkAvatar :user="user" :class="$style.pickedAvatar" :link="false"/>
					<span :class="$style.pickedBody">
						<MkUserName :user="user" :class="$style.pickedName"/>
						<MkAcct :user="user" :class="$style.pickedAcct"/>
					</span>
					<button type="button" class="_button" :class="$style.unpick" :aria-label="i18n.tsx.removeFromSelection({ x: user.name || user.username })" @click="unpick(user)"><i class="ti ti-x"></i></button>
				</li>
			</ul>
		</div>
		<div :class="$style.result">
			<div v-if="listedUsers.length > 0" :class="$style.users">
				<button
					v-for="user in listedUsers"
					:key="user.id"
					type="button"
					class="_button"
					:class="[$style.user, { [$style.selected]: isSelected(user), [$style.unavailable]: unavailableReasons[user.id] != null }]"
					:aria-pressed="isSelected(user)"
					:aria-disabled="unavailableReasons[user.id] != null ? true : undefined"
					@click="onClickUser(user)"
					@dblclick="onDblclickUser()"
				>
					<MkAvatar :user="user" :class="$style.avatar" indicator :link="false"/>
					<span :class="$style.userBody">
						<MkUserName :user="user" :class="$style.userName"/>
						<MkAcct :user="user" :class="$style.userAcct"/>
						<span v-if="unavailableReasons[user.id] != null" :class="$style.userNote">{{ unavailableReasons[user.id] }}</span>
					</span>
					<i v-if="multiple && isSelected(user)" class="ti ti-check" :class="$style.userCheck" aria-hidden="true"></i>
				</button>
			</div>
			<div v-else-if="searching && !waitingForUsers" :class="$style.empty">
				<span>{{ i18n.ts.noUsers }}</span>
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
	(ev: 'okMultiple', selected: Misskey.entities.UserLite[]): void;
	(ev: 'cancel'): void;
	(ev: 'closed'): void;
}>();

const props = withDefaults(defineProps<{
	includeSelf?: boolean;
	localOnly?: boolean;
	// 検索し直しても選んだ人を残し、何人でも選べるようにする
	multiple?: boolean;
	// 選べない人の ID とその理由。窓を待たせないよう、開いたあとで届いてよい
	unavailableUsers?: Promise<Record<string, string>>;
}>(), {
	includeSelf: false,
	localOnly: false,
	multiple: false,
	unavailableUsers: undefined,
});

const computedLocalOnly = computed(() => props.localOnly || instance.federation === 'none');

const username = ref('');
const host = ref('');
const users = ref<Misskey.entities.UserLite[]>([]);
const recentUsers = ref<Misskey.entities.UserDetailed[]>([]);
const selected = ref<Misskey.entities.UserLite | null>(null);
const pickedUsers = ref<Misskey.entities.UserLite[]>([]);
const unavailableReasons = ref<Record<string, string>>({});
const dialogEl = useTemplateRef('dialogEl');
const lookingUp = ref(false);
// 答えが来るまでは前の結果を出したままにし、まだ分からないうちは「誰もいない」と言わない
const waitingForUsers = ref(false);
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
// 「@sora@example.com」を貼り付けたら、ユーザー名とホストの欄に分ける。
// 打っている途中で分けると続きの文字がユーザー名の欄に入ってしまうので、一度に入ったときだけ分ける (打った場合も searchQuery が同じように読む)
watch(username, (value, previous) => {
	if (computedLocalOnly.value || value.length - previous.length < 2) return;
	const acct = Misskey.acct.parse(value.trim());
	if (!acct.host) return;
	host.value = acct.host.toLowerCase();
	username.value = acct.username;
}, { flush: 'sync' });

const canLookup = computed(() => !computedLocalOnly.value && !!searchQuery.value?.username && !!searchQuery.value.host && searchQuery.value.host !== '.');

function canSelectUser(user: Misskey.entities.UserLite) {
	return (!computedLocalOnly.value || user.host == null) && (props.includeSelf || user.id !== $i?.id);
}

const searching = computed(() => username.value !== '' || host.value !== '');
const listedUsers = computed(() => searching.value ? users.value : recentUsers.value.filter(canSelectUser));

function isSelected(user: Misskey.entities.UserLite) {
	return props.multiple ? pickedUsers.value.some(picked => picked.id === user.id) : selected.value?.id === user.id;
}

function unpick(user: Misskey.entities.UserLite) {
	pickedUsers.value = pickedUsers.value.filter(picked => picked.id !== user.id);
}

function onClickUser(user: Misskey.entities.UserLite) {
	if (unavailableReasons.value[user.id] != null) return;
	if (!props.multiple) {
		selected.value = user;
	} else if (isSelected(user)) {
		unpick(user);
	} else {
		pickedUsers.value = [...pickedUsers.value, user];
	}
}

function onDblclickUser() {
	if (!props.multiple) ok();
}

function search() {
	const currentRequestId = ++requestId;
	selected.value = null;
	lookingUp.value = false;
	const query = searchQuery.value;
	if (query == null || (username.value.trim() === '' && host.value.trim() === '')) {
		users.value = [];
		waitingForUsers.value = false;
		return;
	}

	waitingForUsers.value = true;
	misskeyApi('users/search-by-username-and-host', {
		...query,
		limit: 10,
		detail: false,
	}).then(async _users => {
		if (currentRequestId !== requestId) return;
		showUsers(_users.filter(canSelectUser));
		await addExactLocalUser(query, currentRequestId);
		if (currentRequestId === requestId) waitingForUsers.value = false;
	}).catch(() => {
		if (currentRequestId !== requestId) return;
		showUsers([]);
		waitingForUsers.value = false;
	});
}

// 答えを待つあいだに前の結果の人を押していたら、新しい結果にいないその人を選んだままにしない
function showUsers(found: Misskey.entities.UserLite[]) {
	users.value = found;
	if (selected.value != null && !found.some(user => user.id === selected.value?.id)) selected.value = null;
}

// 検索は、まだノートを書いていないこのサーバーのユーザーを返さない。ユーザー名を最後まで入れたらその人を選べるようにする
async function addExactLocalUser(query: { username: string; host: string; }, currentRequestId: number) {
	const isThisServer = query.host === '' || query.host === '.' || query.host === hostname || query.host === currentHost;
	const name = query.username.toLowerCase();
	if (!isThisServer || name === '' || users.value.some(user => user.host == null && user.username.toLowerCase() === name)) return;

	try {
		const user = await misskeyApi('users/show', { username: query.username, host: null });
		if (currentRequestId === requestId) showUsers([user, ...users.value].filter(canSelectUser));
	} catch {
		// そのユーザー名の人はいない
	}
}

async function lookup() {
	const query = searchQuery.value;
	if (!canLookup.value || lookingUp.value || query == null) return;
	const currentRequestId = ++requestId;
	selected.value = null;
	lookingUp.value = true;
	waitingForUsers.value = true;
	try {
		const user = await misskeyApi('users/show', query);
		if (currentRequestId === requestId) showUsers([user].filter(canSelectUser));
	} catch {
		if (currentRequestId === requestId) showUsers([]);
	} finally {
		if (currentRequestId === requestId) {
			lookingUp.value = false;
			waitingForUsers.value = false;
		}
	}
}

watch([username, host, computedLocalOnly, () => props.includeSelf], search, { flush: 'sync' });
onBeforeUnmount(() => { requestId++; });

// 最近使ったユーザー更新。先に渡した人ほど新しい
function rememberRecentUsers(userIds: string[]) {
	const recents = [...userIds, ...store.s.recentlyUsedUsers.filter(id => !userIds.includes(id))];
	store.set('recentlyUsedUsers', recents.slice(0, 16));
}

async function ok() {
	if (props.multiple) {
		if (pickedUsers.value.length === 0) return;
		emit('okMultiple', [...pickedUsers.value]);
		dialogEl.value?.close();
		rememberRecentUsers(pickedUsers.value.map(user => user.id).toReversed());
		return;
	}

	if (selected.value == null) return;
	const selectedId = selected.value.id;
	const currentRequestId = requestId;

	const user = await misskeyApi('users/show', {
		userId: selectedId,
	});
	if (currentRequestId !== requestId || selected.value?.id !== selectedId) return;
	emit('ok', user);

	dialogEl.value?.close();

	rememberRecentUsers([selectedId]);
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

	// 読めなければ誰でも選べるままにする。選べない人はサーバーが断る
	props.unavailableUsers?.then(reasons => {
		unavailableReasons.value = reasons;
		pickedUsers.value = pickedUsers.value.filter(user => reasons[user.id] == null);
	}).catch(() => {});
});
</script>

<style lang="scss" module>
.form {
	padding: calc(var(--root-margin) / 2) var(--root-margin);
}

.result {
	display: flex;
	flex-direction: column;
	overflow: auto;
	height: 100%;
}

// 結果を送っても、選んだ人が見えているようにする。多すぎるときはここだけを送る
.picked {
	position: sticky;
	top: 0;
	z-index: 1;
	padding: 0 var(--root-margin) 8px;
	background: var(--MI_THEME-bg);
}

.pickedLabel {
	font-size: 0.85em;
	opacity: 0.8;
}

.pickedUsers {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	// 画面に余裕があれば広く見せ、キーボードが出ていても結果の場所は残す
	max-height: max(112px, 30cqh);
	overflow-y: auto;
	margin: 6px 0 0;
	padding: 0;
	list-style: none;
}

.pickedUser {
	display: flex;
	align-items: center;
	gap: 6px;
	box-sizing: border-box;
	max-width: 100%;
	min-width: 0;
	padding: 2px 2px 2px 6px;
	border-radius: 12px;
	background: var(--MI_THEME-buttonBg);
	font-size: 0.85em;
}

.pickedAvatar {
	flex-shrink: 0;
	width: 28px;
	height: 28px;
}

.pickedBody {
	display: flex;
	flex-direction: column;
	min-width: 0;
	line-height: 1.3;
}

.pickedName,
.pickedAcct {
	display: block;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
}

.pickedName {
	font-weight: bold;
}

.pickedAcct {
	font-size: 0.9em;
	opacity: 0.8;
}

.unpick {
	flex-shrink: 0;
	width: 32px;
	height: 32px;
	border-radius: 100%;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
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

	// 強調色の上の文字色はテーマが決める。明るい強調色のテーマでは白だと読めない
	&.selected {
		background: var(--MI_THEME-accent);
		color: var(--MI_THEME-fgOnAccent);

		// 普段のアカウント名は薄くしてあるが、強調色の上では読めなくなる。MkAcct はホストを style で更に薄くしている
		.userAcct {
			opacity: 1;
		}

		.userAcct :global(span) {
			opacity: 1 !important;
		}
	}
}

.userBody {
	flex: 1;
	padding: 0 8px;
	min-width: 0;
}

.userCheck {
	flex-shrink: 0;
	padding-left: 8px;
}

.userNote {
	display: block;
	font-size: 0.85em;
}

// 理由は読めるように、人の方だけを薄くする
.unavailable {
	cursor: default;

	&:hover {
		background: none;
	}

	.avatar,
	.userName,
	.userAcct {
		opacity: 0.5;
	}
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
