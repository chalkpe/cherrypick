<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 600px; --MI_SPACER-min: 16px; --MI_SPACER-max: 32px;">
		<XEditor v-if="data" v-model="data"/>
	</div>
	<template #footer>
		<div :class="$style.footer">
			<div class="_spacer" style="--MI_SPACER-w: 600px; --MI_SPACER-min: 16px; --MI_SPACER-max: 16px;">
				<MkButton primary rounded :disabled="saving" @click="save"><i class="ti ti-check"></i> {{ i18n.ts.save }}</MkButton>
			</div>
		</div>
	</template>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue';
import * as Misskey from 'cherrypick-js';
import XEditor from './roles.editor.vue';
import { confirmRoleTierFix } from './roles.tier-fix.js';
import type { RoleTierFix, RoleTierRole } from '@/utility/role-tier.js';
import { applyRoleTierFix } from '@/utility/role-tier.js';
import { instance } from '@/instance.js';
import { genId } from '@/utility/id.js';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import MkButton from '@/components/MkButton.vue';
import { rolesCache } from '@/cache.js';
import { useRouter } from '@/router.js';

const router = useRouter();

const props = defineProps<{
	id?: string;
}>();

type RoleLike = Pick<Misskey.entities.Role, 'name' | 'description' | 'isAdministrator' | 'isModerator' | 'color' | 'iconUrl' | 'target' | 'isPublic' | 'isExplorable' | 'asBadge' | 'canEditMembersByModerator' | 'displayOrder' | 'preserveAssignmentOnMoveAccount'> & {
	condFormula: any;
	policies: any;
};

const role = ref<Misskey.entities.Role | null>(null);
const data = ref<RoleLike | null>(null);

if (props.id) {
	role.value = await misskeyApi('admin/roles/show', {
		roleId: props.id,
	});

	data.value = role.value;
} else {
	data.value = {
		name: 'New Role',
		description: '',
		isAdministrator: false,
		isModerator: false,
		color: null,
		iconUrl: null,
		target: 'manual',
		condFormula: { id: genId(), type: 'isRemote' },
		isPublic: false,
		isExplorable: false,
		asBadge: false,
		canEditMembersByModerator: false,
		displayOrder: 0,
		preserveAssignmentOnMoveAccount: false,
		policies: {},
	};
}

function fixedFieldsOf(target: RoleTierRole, fix: RoleTierFix): Pick<RoleLike, 'condFormula' | 'policies'> {
	return applyRoleTierFix(target, fix);
}

async function saveFixedRoles(id: string, current: RoleTierRole, others: Misskey.entities.Role[], fix: RoleTierFix) {
	try {
		// 권한을 모두 복사한 뒤에 조건을 좁혀, 중간에 실패해도 상위 등급 사용자가 권한을 먼저 잃지 않게 한다.
		for (const other of others.filter(r => fix.lowered.some(item => item.role === r))) {
			await os.apiWithDialog('admin/roles/update', { roleId: other.id, policies: fixedFieldsOf(other, fix).policies });
		}
		for (const target of [current, ...others].filter(r => fix.caps.some(cap => cap.role === r))) {
			await os.apiWithDialog('admin/roles/update', { roleId: target.id ?? id, condFormula: fixedFieldsOf(target, fix).condFormula });
		}
	} catch {
		// 오류는 안내창으로 이미 표시했고, 역할을 다시 저장하면 남은 수정을 다시 제안한다.
	}
}

const saving = ref(false);

async function save() {
	// 역할 목록을 불러오는 동안에는 안내창이 없으므로, 다시 눌러 중복 저장되지 않게 막는다.
	if (saving.value) return;
	saving.value = true;
	try {
		await saveRole();
	} finally {
		saving.value = false;
	}
}

async function saveRole() {
	if (data.value === null) return;

	// 안내는 저장을 돕는 부가 기능이므로, 목록을 불러오지 못해도 저장은 막지 않는다.
	const roles = await misskeyApi('admin/roles/list').catch(() => []);
	// 목록을 불러오는 동안에는 편집할 수 있으므로, 불러온 뒤의 내용으로 저장한다.
	const current: RoleTierRole = { ...data.value, id: role.value?.id ?? null };
	const others = roles.filter(r => r.id !== current.id);
	const fix = await confirmRoleTierFix(current, others, instance.policies);
	if (fix === null) return;

	// 저장 중인 역할의 조건은 다른 역할의 권한을 복사한 뒤에 saveFixedRoles에서 좁힌다.
	const fixed: RoleLike = { ...data.value, policies: fixedFieldsOf(current, fix).policies };
	rolesCache.delete();
	let id: string;
	try {
		if (role.value) {
			await os.apiWithDialog('admin/roles/update', {
				roleId: role.value.id,
				...fixed,
			});
			id = role.value.id;
		} else {
			const created = await os.apiWithDialog('admin/roles/create', {
				...fixed,
			});
			id = created.id;
		}
	} catch {
		// 오류는 안내창으로 이미 표시했다. 편집 내용을 잃지 않도록 이 화면에 남는다.
		return;
	}

	await saveFixedRoles(id, current, others, fix);
	router.push('/admin/roles/:id', {
		params: {
			id,
		},
	});
}

const headerTabs = computed(() => []);

definePage(() => ({
	title: role.value ? `${i18n.ts._role.edit}: ${role.value.name}` : i18n.ts._role.new,
	icon: 'ti ti-badge',
}));
</script>

<style lang="scss" module>
.footer {
	-webkit-backdrop-filter: var(--MI-blur, blur(15px));
	backdrop-filter: var(--MI-blur, blur(15px));
}
</style>
