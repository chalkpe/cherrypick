/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';
import { nextTick } from 'vue';

const mocks = vi.hoisted(() => ({ apiWithDialog: vi.fn(), api: vi.fn(), confirm: vi.fn(), push: vi.fn(), me: { id: 'me', isAdmin: false, isModerator: false } }));
vi.mock('@/i.js', () => ({ ensureSignin: () => mocks.me }));
vi.mock('@/os.js', () => ({ apiWithDialog: mocks.apiWithDialog, confirm: mocks.confirm }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/utility/choose-avatar.js', () => ({ chooseAvatar: vi.fn() }));
vi.mock('@/pages/settings/avatar-decoration.vue', () => ({ default: { template: '<div/>' } }));

import XInfo from '@/pages/chat/room.info.vue';
import { chatRoomDeleteErrors, chatRoomUpdateErrors } from '@/pages/chat/chat-errors.js';
import XRoom from '@/pages/chat/XRoom.vue';
import { i18n } from '@/i18n.js';

const room = { id: 'r1', ownerId: 'me', owner: { id: 'me', username: 'me' }, name: ':test: room', description: ':test: description' } as any;
const stubs = {
	XChannelManagement: true,
	MkInput: { props: ['modelValue', 'mfmAutocomplete'], emits: ['update:modelValue'], template: '<label><slot name="label"/><input :value="modelValue" :data-autocomplete="JSON.stringify(mfmAutocomplete)" @input="$emit(\'update:modelValue\', $event.target.value)"/><slot name="caption"/></label>' },
	MkTextarea: { props: { modelValue: String, mfmAutocomplete: Array, mfmPreview: Boolean }, emits: ['update:modelValue'], template: '<label><slot name="label"/><textarea :value="modelValue" :data-autocomplete="JSON.stringify(mfmAutocomplete)" :data-preview="mfmPreview" @input="$emit(\'update:modelValue\', $event.target.value)"/></label>' },
	MkButton: { emits: ['click'], template: '<button @click="$emit(\'click\')"><slot/></button>' },
	MkSwitch: true,
	// 실제 MkSelect처럼 items만 선택지로 그린다. 기본 슬롯의 <option>은 쓰지 않는다.
	MkSelect: { props: ['modelValue', 'items'], emits: ['update:modelValue'], template: '<label><slot name="label"/><select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>' },
	MkKeyValue: { template: '<div><slot name="key"/><slot name="value"/></div>' },
	MkAvatar: true,
	MkA: { template: '<a><slot/></a>' },
	Mfm: { props: ['text', 'plain'], template: '<span data-testid="mfm" :data-plain="plain">{{ text }}</span>' },
};

afterEach(() => { cleanup(); mocks.apiWithDialog.mockReset(); mocks.api.mockReset(); mocks.confirm.mockReset(); mocks.push.mockReset(); });

test('채널 상속과 개별 설정을 한 번의 개인 설정 조회로 표시한다', async () => {
	mocks.api.mockImplementation(async endpoint => endpoint === 'chat/rooms/channels/list'
		? [{ id: 'general', name: 'general' }, { id: 'other', name: 'other' }]
		: { level: 'mentions', channelOverrides: [{ channelId: 'other', level: 'all' }] });
	mocks.apiWithDialog.mockResolvedValueOnce({ level: 'inherit', effectiveLevel: 'mentions' });
	render(XInfo, { props: { room: { ...room, hasChannels: true, notificationLevel: 'mentions' } }, global: { stubs } });
	const other = await screen.findByRole('combobox', { name: '#other' });
	const general = screen.getByRole('combobox', { name: '#general' });

	expect([...(general as HTMLSelectElement).options].map(option => option.textContent)).toEqual([i18n.ts._chat.notificationInherit, i18n.ts._chat.notificationAll, i18n.ts._chat.notificationMentions, i18n.ts._chat.notificationNone]);
	expect((other as HTMLSelectElement).value).toBe('all');

	await fireEvent.update(other, 'inherit');

	expect((general as HTMLSelectElement).value).toBe('inherit');
	expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/notifications')).toHaveLength(1);
	await waitFor(() => expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/notifications', { roomId: 'r1', channelId: 'other', level: 'inherit' }, undefined, expect.any(Object)));
});

test.each(['me', 'someone-else'])('그룹장과 멤버가 같은 세 단계 개인 설정을 쓴다 (그룹장=%s)', async ownerId => {
	mocks.apiWithDialog.mockResolvedValueOnce({ level: 'mentions', effectiveLevel: 'mentions' });
	render(XInfo, { props: { room: { ...room, ownerId, notificationLevel: 'all' } }, global: { stubs } });
	const select = screen.getByRole('combobox', { name: i18n.ts.notificationSetting });
	expect([...(select as HTMLSelectElement).options].map(option => option.textContent)).toEqual([i18n.ts._chat.notificationAll, i18n.ts._chat.notificationMentions, i18n.ts._chat.notificationNone]);

	await fireEvent.update(select, 'mentions');

	await waitFor(() => expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/notifications', { roomId: 'r1', level: 'mentions' }, undefined, expect.any(Object)));
	expect((select as HTMLSelectElement).value).toBe('mentions');
});

test('개인 알림 설정을 저장하지 못하면 이전 값으로 돌아간다', async () => {
	mocks.apiWithDialog.mockRejectedValueOnce(new Error('failed'));
	render(XInfo, { props: { room: { ...room, notificationLevel: 'all' } }, global: { stubs } });
	const select = screen.getByRole('combobox', { name: i18n.ts.notificationSetting });

	await fireEvent.update(select, 'none');

	await waitFor(() => expect(mocks.apiWithDialog).toHaveBeenCalled());
	await nextTick();
	expect((select as HTMLSelectElement).value).toBe('all');
});

test('the owner archives the room after confirming, and the saved room propagates', async () => {
	const updated = { ...room, isArchived: true };
	mocks.confirm.mockResolvedValueOnce({ canceled: false });
	mocks.apiWithDialog.mockResolvedValueOnce(updated);
	const result = render(XInfo, { props: { room: { ...room, isArchived: false } }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.archive }));
	await waitFor(() => expect(result.emitted().updated).toEqual([[updated]]));
	expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/update', { roomId: 'r1', isArchived: true }, undefined, chatRoomUpdateErrors);
});

test('tells the room page while its own deletion is in progress', async () => {
	mocks.confirm.mockResolvedValueOnce({ canceled: false });
	mocks.apiWithDialog.mockResolvedValueOnce(undefined);
	const result = render(XInfo, { props: { room: { ...room, isArchived: false } }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat.deleteRoom }));
	await waitFor(() => expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/delete', { roomId: 'r1' }, undefined, chatRoomDeleteErrors));
	expect(result.emitted().deleting).toEqual([[true]]);
});

test('a failed deletion lets later deletions be announced again', async () => {
	mocks.confirm.mockResolvedValueOnce({ canceled: false });
	mocks.apiWithDialog.mockRejectedValueOnce(new Error('failed'));
	const result = render(XInfo, { props: { room: { ...room, isArchived: false } }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat.deleteRoom }));
	await waitFor(() => expect(result.emitted().deleting).toEqual([[true], [false]]));
});

test('leaves the page when the deletion fails after the room has already closed', async () => {
	let fail!: (reason: unknown) => void;
	mocks.confirm.mockResolvedValueOnce({ canceled: false });
	mocks.apiWithDialog.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
	const result = render(XInfo, { props: { room: { ...room, isArchived: false } }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat.deleteRoom }));
	await waitFor(() => expect(mocks.apiWithDialog).toHaveBeenCalled());
	result.unmount();

	fail(new Error('No such room.'));

	await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/chat'));
});

test('stays on the page when the deletion fails while the room is still open', async () => {
	mocks.confirm.mockResolvedValueOnce({ canceled: false });
	mocks.apiWithDialog.mockRejectedValueOnce(new Error('failed'));
	const result = render(XInfo, { props: { room: { ...room, isArchived: false } }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat.deleteRoom }));
	await waitFor(() => expect(result.emitted().deleting).toEqual([[true], [false]]));
	expect(mocks.push).not.toHaveBeenCalled();
});

test('canceling the confirmation does not archive', async () => {
	mocks.confirm.mockResolvedValueOnce({ canceled: true });
	render(XInfo, { props: { room: { ...room, isArchived: false } }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.archive }));
	await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
	await nextTick();
	expect(mocks.apiWithDialog).not.toHaveBeenCalled();
});

test('an archived room offers unarchiving without a confirmation, and no saving', async () => {
	mocks.apiWithDialog.mockResolvedValueOnce({ ...room, isArchived: false });
	render(XInfo, { props: { room: { ...room, isArchived: true } }, global: { stubs } });
	expect(screen.queryByRole('button', { name: i18n.ts.save })).toBeNull();
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.unarchive }));
	await waitFor(() => expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/update', { roomId: 'r1', isArchived: false }, undefined, chatRoomUpdateErrors));
	expect(mocks.confirm).not.toHaveBeenCalled();
});

// 알림 끄기는 보는 본인만의 설정이고, 방장도 자기 방을 끌 수 있다
const notificationSelect = () => screen.getByRole('combobox', { name: i18n.ts.notificationSetting }) as HTMLSelectElement;

test.each([
	['the owner', 'me'],
	['a member', 'someone-else'],
])('%s mutes the room, and the choice propagates to the room page', async (_, ownerId) => {
	mocks.apiWithDialog.mockResolvedValueOnce(undefined);
	const shown = { ...room, ownerId, isArchived: false, isMuted: false };
	const result = render(XInfo, { props: { room: shown }, global: { stubs } });
	expect(notificationSelect().value).toBe('all');

	await fireEvent.update(notificationSelect(), 'none');

	// ページが持つルームに伝えないと、タブを切り替えて戻ったときに選択が元に戻って見える
	await waitFor(() => expect(result.emitted().updated).toEqual([[{ ...shown, notificationLevel: 'none', isMuted: true }]]));
	expect(mocks.apiWithDialog).toHaveBeenCalledExactlyOnceWith('chat/rooms/notifications', { roomId: 'r1', level: 'none' }, undefined, expect.any(Object));
	expect(notificationSelect().value).toBe('none');
});

test('the owner unmutes a room they muted', async () => {
	mocks.apiWithDialog.mockResolvedValueOnce(undefined);
	const shown = { ...room, isArchived: false, isMuted: true };
	const result = render(XInfo, { props: { room: shown }, global: { stubs } });
	expect(notificationSelect().value).toBe('none');

	await fireEvent.update(notificationSelect(), 'all');

	await waitFor(() => expect(result.emitted().updated).toEqual([[{ ...shown, notificationLevel: 'all', isMuted: false }]]));
	expect(mocks.apiWithDialog).toHaveBeenCalledExactlyOnceWith('chat/rooms/notifications', { roomId: 'r1', level: 'all' }, undefined, expect.any(Object));
});

test('a mute that was refused is not passed on to the room page', async () => {
	mocks.apiWithDialog.mockRejectedValueOnce(new Error('refused'));
	const result = render(XInfo, { props: { room: { ...room, isArchived: false, isMuted: false } }, global: { stubs } });

	await fireEvent.update(notificationSelect(), 'none');

	await waitFor(() => expect(mocks.apiWithDialog).toHaveBeenCalled());
	await waitFor(() => expect(notificationSelect().value).toBe('all'));
	expect(result.emitted().updated).toBeUndefined();
});

test('the notification setting follows the room when the page reads it again', async () => {
	const shown = { ...room, isArchived: false, isMuted: false };
	const result = render(XInfo, { props: { room: shown }, global: { stubs } });

	await result.rerender({ room: { ...shown, notificationLevel: 'none', isMuted: true } });

	expect(notificationSelect().value).toBe('none');
});

test('other members cannot archive', () => {
	render(XInfo, { props: { room: { ...room, ownerId: 'someone-else', isArchived: false } }, global: { stubs } });
	expect(screen.queryByRole('button', { name: i18n.ts.archive })).toBeNull();
});

test('enables emoji completion for both editable fields and propagates the saved room', async () => {
	const updated = { ...room, name: ':other: name', description: ':other: description' };
	mocks.apiWithDialog.mockResolvedValueOnce(updated);
	const result = render(XInfo, { props: { room }, global: { stubs } });
	const input = screen.getByLabelText(new RegExp(i18n.ts.name));
	const textarea = screen.getByLabelText(i18n.ts.description);
	expect(input.getAttribute('data-autocomplete')).toBe('["emoji"]');
	expect(textarea.getAttribute('data-autocomplete')).toBe('["emoji"]');
	expect(textarea.getAttribute('data-preview')).toBe('true');
	await fireEvent.update(input, updated.name);
	await fireEvent.update(textarea, updated.description);
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.save }));
	await nextTick();
	expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/update', { roomId: 'r1', name: updated.name, description: updated.description }, undefined, chatRoomUpdateErrors);
	expect(result.emitted().updated).toEqual([[updated]]);
});

test('renders the name and description with MFM for other members', () => {
	render(XInfo, { props: { room: { ...room, ownerId: 'someone-else' } }, global: { stubs } });
	expect(screen.queryByRole('textbox')).toBeNull();
	expect(screen.getAllByTestId('mfm').map(el => el.textContent)).toEqual([room.name, room.description]);
});

test('uses MFM for the room card name and description', () => {
	render(XRoom, { props: { room }, global: { stubs } });
	expect(screen.getAllByTestId('mfm').map(el => el.textContent)).toEqual([room.name, room.description]);
});

test('keeps channel notification options in sync with the parent management list', async () => {
	mocks.api.mockImplementation(async endpoint => endpoint === 'chat/rooms/channels/list'
		? [{ id: 'stale', name: 'Stale name' }]
		: { level: 'all', channelOverrides: [{ channelId: 'kept', level: 'mentions' }] });
	const view = render(XInfo, { props: { room: { ...room, hasChannels: true }, channels: [{ id: 'kept', roomId: 'r1', name: 'Current name' }] as any }, global: { stubs } });
	const kept = await screen.findByRole('combobox', { name: '#Current name' });
	await waitFor(() => expect((kept as HTMLSelectElement).value).toBe('mentions'));
	expect(screen.queryByRole('combobox', { name: '#Stale name' })).toBeNull();
	await view.rerender({ channels: [{ id: 'kept', roomId: 'r1', name: 'Renamed' }, { id: 'new', roomId: 'r1', name: 'Added' }] });
	expect((await screen.findByRole('combobox', { name: '#Renamed' }) as HTMLSelectElement).value).toBe('mentions');
	expect(screen.getByRole('combobox', { name: '#Added' })).toBeDefined();
	await view.rerender({ channels: [{ id: 'new', roomId: 'r1', name: 'Added' }] });
	expect(screen.queryByRole('combobox', { name: '#Renamed' })).toBeNull();
});

test('그룹장 화면은 구분선으로 나눈 구역 순서로 보관과 삭제를 맨 아래에 둔다', async () => {
	mocks.api.mockResolvedValue(null);
	const { container } = render(XInfo, { props: { room: { ...room, notificationLevel: 'all' } }, global: { stubs } });
	await nextTick();
	const root = container.firstElementChild as HTMLElement;
	expect([...root.querySelectorAll(':scope > hr')]).toHaveLength(4);
	const order = (node: Element) => [...root.children].findIndex(child => child === node || child.contains(node));
	const notification = order(screen.getByRole('combobox', { name: i18n.ts.notificationSetting }));
	const archive = order(screen.getByRole('button', { name: i18n.ts.archive }));
	const remove = order(screen.getByRole('button', { name: i18n.ts._chat.deleteRoom }));
	const lastSeparator = [...root.children].map(child => child.tagName).lastIndexOf('HR');
	expect(notification).toBeLessThan(lastSeparator);
	expect(lastSeparator).toBeLessThan(archive);
	expect(archive).toBeLessThan(remove);
});

test('멤버 화면은 정보와 알림 두 구역만 구분선으로 나눈다', () => {
	const { container } = render(XInfo, { props: { room: { ...room, ownerId: 'someone-else', notificationLevel: 'all' } }, global: { stubs } });
	expect(container.querySelectorAll('hr')).toHaveLength(1);
	expect(screen.queryByRole('button', { name: i18n.ts._chat.deleteRoom })).toBeNull();
});

test('그룹장 화면에 녹화 허용 스위치가 실제 컴포넌트로 그려진다', async () => {
	mocks.api.mockResolvedValue({ level: 'all', channelOverrides: [] });
	const { MkSwitch: _omitted, ...withoutSwitch } = stubs;
	const { container } = render(XInfo, { props: { room: { ...room, allowRecording: true } }, global: { stubs: withoutSwitch } });
	await nextTick();

	expect(container.querySelector('mkswitch')).toBeNull();
	expect(screen.getByText(i18n.ts._voiceCall.allowRecording)).toBeTruthy();
});
