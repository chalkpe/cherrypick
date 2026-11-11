<!--
SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<PageWithHeader>
 <div class="_spacer" style="--MI_SPACER-w: 800px;">
  <SearchMarker path="/admin/voice-relay" :label="i18n.ts._voiceRelay.settingsTitle" :keywords="['call', 'voice', 'livekit', 'turn', 'cloudflare', 'relay', 'rental', 'borrow', '통화', '인프라', '대여', '대여하기', '通話', 'レンタル', '借りる']" icon="ti ti-phone">
   <div class="_gaps">
    <MkFolder accessible>
     <template #icon><i class="ti ti-users"></i></template>
     <template #label>{{ i18n.ts._voiceRelay.capacityTitle }}</template>
     <template v-if="capacityForm.modified.value" #footer><MkFormFooter :form="capacityForm"/></template>
     <MkInput v-model="capacityForm.state.limit" accessible type="number" :min="1" :max="51" :step="1">
      <template #label>{{ i18n.ts._voiceRelay.capacityTitle }} <span v-if="capacityForm.modifiedStates.limit" class="_modified">{{ i18n.ts.modified }}</span></template>
      <template #caption>{{ i18n.ts._voiceRelay.capacityDescription }}</template>
     </MkInput>
    </MkFolder>
    <MkFolder accessible>
     <template #icon><i class="ti ti-phone"></i></template>
     <template #label>{{ i18n.ts._voiceRelay.livekitTitle }}</template>
     <template v-if="livekitForm.modified.value" #footer><MkFormFooter :form="livekitForm"/></template>
     <div class="_gaps">
      <MkInfo>{{ i18n.ts._voiceRelay.livekitDescription }}</MkInfo>
      <MkRadios v-model="livekitForm.state.source" :options="[{ value: 'yaml', label: i18n.ts._voiceRelay.sourceYaml }, { value: 'custom', label: i18n.ts._voiceRelay.sourceCustom }, { value: 'disabled', label: i18n.ts._voiceRelay.sourceDisabled }]" vertical>
       <template #label>{{ i18n.ts._voiceRelay.livekitSource }} <span v-if="livekitForm.modifiedStates.source" class="_modified">{{ i18n.ts.modified }}</span></template>
      </MkRadios>
      <template v-if="livekitForm.state.source === 'custom'">
       <MkInput v-model="livekitForm.state.url" accessible type="url"><template #label>{{ i18n.ts._voiceRelay.livekitUrl }} <span v-if="livekitForm.modifiedStates.url" class="_modified">{{ i18n.ts.modified }}</span></template></MkInput>
       <MkInput v-model="livekitForm.state.key" accessible autocomplete="off"><template #label>{{ i18n.ts._voiceRelay.livekitKey }} <span v-if="livekitForm.modifiedStates.key" class="_modified">{{ i18n.ts.modified }}</span></template></MkInput>
       <MkInput v-model="livekitForm.state.secret" accessible type="password" autocomplete="new-password"><template #label>{{ i18n.ts._voiceRelay.livekitSecret }} <span v-if="livekitForm.modifiedStates.secret" class="_modified">{{ i18n.ts.modified }}</span></template><template #caption>{{ i18n.ts._voiceRelay.secretHelp }}</template></MkInput>
      </template>
      <MkSwitch v-if="livekitSecretSet && livekitForm.state.source !== 'custom'" v-model="livekitForm.state.clearSecret" accessible>{{ i18n.ts._voiceRelay.deleteSecret }}</MkSwitch>
      <MkInfo v-if="livekitSecretSet">{{ i18n.ts._voiceRelay.secretSet }}</MkInfo>
      <MkRadios v-model="livekitForm.state.preference" :options="[{ value: 'yaml', label: i18n.ts._voiceRelay.preferYaml }, { value: 'local', label: i18n.ts._voiceRelay.preferLocal }, { value: 'relay', label: i18n.ts._voiceRelay.preferRelay }]" vertical>
       <template #label>{{ i18n.ts._voiceRelay.preference }} <span v-if="livekitForm.modifiedStates.preference" class="_modified">{{ i18n.ts.modified }}</span></template>
      </MkRadios>
     </div>
    </MkFolder>
    <MkFolder accessible>
     <template #icon><i class="ti ti-router"></i></template>
     <template #label>{{ i18n.ts._serverSettings.voiceCallCloudflareTurn }}</template>
     <template v-if="turnForm.modified.value" #footer><MkFormFooter :form="turnForm"/></template>
     <div class="_gaps">
      <MkInfo>{{ i18n.ts._serverSettings.voiceCallCloudflareTurnDescription }}</MkInfo>
      <MkInput v-model="turnForm.state.keyId" accessible autocomplete="off"><template #label>{{ i18n.ts._serverSettings.voiceCallCloudflareTurnKeyId }} <span v-if="turnForm.modifiedStates.keyId" class="_modified">{{ i18n.ts.modified }}</span></template></MkInput>
      <MkInput v-model="turnForm.state.token" accessible type="password" autocomplete="new-password"><template #label>{{ i18n.ts._serverSettings.voiceCallCloudflareTurnApiToken }} <span v-if="turnForm.modifiedStates.token" class="_modified">{{ i18n.ts.modified }}</span></template><template #caption>{{ i18n.ts._voiceRelay.secretHelp }}</template></MkInput>
      <MkSwitch v-if="turnSecretSet" v-model="turnForm.state.clearSecret" accessible>{{ i18n.ts._voiceRelay.deleteSecret }}</MkSwitch>
      <MkInfo v-if="turnSecretSet">{{ i18n.ts._voiceRelay.secretSet }}</MkInfo>
      <MkInfo warn>{{ i18n.ts._serverSettings.voiceCallCloudflareTurnKeyChangeDescription }}</MkInfo>
     </div>
    </MkFolder>
    <MkFolder accessible :withSpacer="false">
     <template #icon><i class="ti ti-phone"></i></template>
     <template #label>{{ i18n.ts._voiceRelay.title }}</template>
     <div class="_gaps" :class="$style.section">
      <MkInfo>{{ i18n.ts._voiceRelay.description }}</MkInfo>
      <h3>{{ i18n.ts._voiceRelay.consumer }}</h3>
      <div v-for="provider in settings?.providers ?? []" :key="provider.id" class="_gaps_s" :class="$style.entry">
       <strong>{{ provider.origin }}</strong>
       <span>{{ provider.validated ? i18n.ts._voiceRelay.approved : i18n.ts._voiceRelay.unchecked }} · {{ provider.enabled ? i18n.ts.enabled : i18n.ts.disabled }}</span>
       <div class="_buttons">
        <MkButton :disabled="busy" @click="edit(provider)">{{ i18n.ts.edit }}</MkButton>
        <MkButton :disabled="busy" @click="run('check-provider', { id: provider.id })">{{ i18n.ts._voiceRelay.check }}</MkButton>
        <MkButton danger :disabled="busy" @click="removeProvider(provider)">{{ i18n.ts.delete }}</MkButton>
       </div>
      </div>
      <MkInput v-model="providerDraft.origin" accessible type="url"><template #label>{{ i18n.ts._voiceRelay.origin }}</template></MkInput>
      <MkInput v-model="providerDraft.secret" accessible type="password" autocomplete="new-password"><template #label>{{ i18n.ts._voiceRelay.keyRef }}</template><template #caption>{{ i18n.ts._voiceRelay.keyHelp }}</template></MkInput>
      <MkSwitch v-model="providerDraft.enabled" accessible>{{ i18n.ts.enable }}</MkSwitch>
      <div class="_buttons">
       <MkButton primary :disabled="busy || !providerDraft.origin || (!providerDraft.id && !providerDraft.secret)" @click="run('save-provider', { ...providerDraft, id: providerDraft.id || undefined, secret: providerDraft.secret || undefined })">{{ i18n.ts.save }}</MkButton>
       <MkButton v-if="providerDraft.id" :disabled="busy" @click="resetProvider">{{ i18n.ts.cancel }}</MkButton>
      </div>
     </div>
    </MkFolder>

   </div>
  </SearchMarker>
 </div>
</PageWithHeader>
</template>
<script lang="ts" setup>
import { reactive, ref } from 'vue';
import type * as Misskey from 'cherrypick-js';
import MkButton from '@/components/MkButton.vue';
import MkInput from '@/components/MkInput.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkRadios from '@/components/MkRadios.vue';
import MkFormFooter from '@/components/MkFormFooter.vue';
import { useForm } from '@/composables/use-form.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import * as os from '@/os.js';
import { fetchInstance } from '@/instance.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
type Request = Misskey.Endpoints['admin/voice-relay/manage']['req'];
type Settings = Misskey.Endpoints['admin/voice-relay/manage']['res'];
const settings = ref<Settings | null>(null);
const busy = ref(false);
const providerDraft = reactive({ id: '', origin: '', secret: '', enabled: true });
const meta = await misskeyApi('admin/meta');
const livekitSecretSet = ref(meta.voiceCallLivekitApiSecretSet);
const turnSecretSet = ref(meta.voiceCallCloudflareTurnApiTokenSet);
const capacityForm = useForm({ limit: meta.voiceCallMaxParticipants }, async state => {
 await os.apiWithDialog('admin/update-meta', { voiceCallMaxParticipants: state.limit });
});
const livekitForm = useForm({ source: meta.voiceCallLivekitSource, url: meta.voiceCallLivekitUrl ?? '', key: meta.voiceCallLivekitApiKey ?? '', secret: '', clearSecret: false, preference: (meta.voiceCallPreferRelay == null ? 'yaml' : meta.voiceCallPreferRelay ? 'relay' : 'local') as 'yaml' | 'local' | 'relay' }, async state => {
 const secret = state.secret.trim();
 await os.apiWithDialog('admin/update-meta', {
  voiceCallLivekitSource: state.source,
  voiceCallLivekitUrl: state.url,
  voiceCallLivekitApiKey: state.key,
  ...(state.clearSecret ? { voiceCallLivekitApiSecret: null } : secret ? { voiceCallLivekitApiSecret: secret } : {}),
  voiceCallPreferRelay: state.preference === 'yaml' ? null : state.preference === 'relay',
 });
 if (state.clearSecret || secret) livekitSecretSet.value = !state.clearSecret;
 livekitForm.state.secret = '';
 livekitForm.state.clearSecret = false;
});
const turnForm = useForm({ keyId: meta.voiceCallCloudflareTurnKeyId ?? '', token: '', clearSecret: false }, async state => {
 const token = state.token.trim();
 await os.apiWithDialog('admin/update-meta', {
  voiceCallCloudflareTurnKeyId: state.keyId,
  ...(state.clearSecret ? { voiceCallCloudflareTurnApiToken: null } : token ? { voiceCallCloudflareTurnApiToken: token } : {}),
 });
 if (state.clearSecret || token) turnSecretSet.value = !state.clearSecret;
 turnForm.state.token = '';
 turnForm.state.clearSecret = false;
});

function resetProvider() { Object.assign(providerDraft, { id: '', origin: '', secret: '', enabled: true }); }

function edit(provider: Settings['providers'][number]) { Object.assign(providerDraft, { id: provider.id, origin: provider.origin, enabled: provider.enabled, secret: '' }); }

async function removeProvider(provider: Settings['providers'][number]) { if (!(await os.confirm({ type: 'warning', text: i18n.tsx.deleteAreYouSure({ x: provider.origin }) })).canceled) { await run('remove-provider', { id: provider.id }); if (providerDraft.id === provider.id) resetProvider(); } }

async function run(action: Request['action'], params: Omit<Partial<Request>, 'action'> = {}) {
 if (busy.value) return;
 busy.value = true;
 try {
  const result = await os.apiWithDialog('admin/voice-relay/manage', { action, ...params });
  settings.value = result;
  if (result.capacity) await os.alert({ type: 'info', text: i18n.tsx._voiceRelay.capacity({ reserved: result.capacity.reservedSlots, max: result.capacity.maxSlots, remaining: result.capacity.remainingSlots }) });
  if (action === 'save-provider') resetProvider();
  await fetchInstance(true);
 } finally { busy.value = false; }
}

misskeyApi('admin/voice-relay/manage', { action: 'list' }).then(result => { settings.value = result; }).catch(err => {
 os.alert({ type: 'error', text: err.message || err });
});
definePage(() => ({ title: i18n.ts._voiceRelay.settingsTitle, icon: 'ti ti-phone', mobileFooterInFlow: true }));
</script>
<style lang="scss" module>
.section { padding: var(--MI-margin); }
.entry { padding-bottom: var(--MI-margin); border-bottom: 1px solid var(--MI_THEME-divider); overflow-wrap: anywhere; }
</style>
