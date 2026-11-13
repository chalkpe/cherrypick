/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';
import type * as Misskey from 'cherrypick-js';

const mocks = vi.hoisted(() => ({ api: vi.fn().mockResolvedValue([]), confirm: vi.fn(), inputText: vi.fn(), alert: vi.fn(), me: { id: 'owner', policies: { chatAvailability: 'available' } } }));
vi.mock('@/i.js', async original => ({ ...await original<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/os.js', () => ({ confirm: mocks.confirm, inputText: mocks.inputText, alert: mocks.alert }));

vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));

import Management from '@/pages/chat/room.channels.manage.vue';
import { i18n } from '@/i18n.js';

const room = { id: 'r', name: 'Group', ownerId: 'owner', isArchived: false, hasChannels: false, legacyChannelId: 'c1' } as Misskey.entities.ChatRoom;
const channels = [{ id: 'c1', roomId: 'r', name: 'same', isLegacy: true }, { id: 'c2', roomId: 'r', name: 'same', isLegacy: false }];
const stubs = { MkButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot/></button>' }, MkInfo: { template: '<div><slot/></div>' } };
beforeEach(() => { vi.resetAllMocks(); mocks.confirm.mockResolvedValue({ canceled: false }); mocks.api.mockResolvedValue([]); });
afterEach(cleanup);

test('confirms the one-way conversion and calls the real conversion endpoint', async () => {
	mocks.api.mockResolvedValue({ ...room, hasChannels: true });
	render(Management, { props: { room }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat._channels.convert }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/convert-to-channels', { roomId: 'r' }));
	expect(mocks.confirm.mock.lastCall![0].text).toBe(`${i18n.ts._chat._channels.convertHistory}\n${i18n.ts._chat._channels.convertPermanent}`);
});

test('prevents non-owner and archived changes', () => {
	const other = render(Management, { props: { room: { ...room, ownerId: 'other' } }, global: { stubs } });
	expect(screen.queryAllByRole('button')).toHaveLength(0);
	other.unmount();
	render(Management, { props: { room: { ...room, isArchived: true } }, global: { stubs } });
	expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
});

test('keeps duplicate names and only trims the edges when creating', async () => {
	mocks.inputText.mockResolvedValue({ canceled: false, result: '  same  ' });
	render(Management, { props: { room: { ...room, hasChannels: true }, channels }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat._channels.create }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/channels/create', { roomId: 'r', name: 'same' }));
});

test('submits the full reordered ID list and warns when deleting the legacy channel', async () => {
	render(Management, { props: { room: { ...room, hasChannels: true }, channels }, global: { stubs } });
	await fireEvent.click(screen.getAllByRole('button', { name: i18n.ts._chat._channels.moveDown })[0]);
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/channels/reorder', { roomId: 'r', channelIds: ['c2', 'c1'] }));
	await fireEvent.click(screen.getAllByRole('button', { name: i18n.ts.delete })[0]);
	await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
	expect(mocks.confirm.mock.lastCall![0].text).toContain(i18n.ts._chat._channels.legacyDeleteWarning);
});

test('blocks the last deletion and creating a 129th channel', () => {
	const single = render(Management, { props: { room: { ...room, hasChannels: true }, channels: channels.slice(0, 1) }, global: { stubs } });
	expect((screen.getByRole('button', { name: i18n.ts.delete }) as HTMLButtonElement).disabled).toBe(true);
	single.unmount();
	const many = Array.from({ length: 128 }, (_, index) => ({ ...channels[0], id: `c${index}` }));
	render(Management, { props: { room: { ...room, hasChannels: true }, channels: many }, global: { stubs } });
	expect((screen.getByRole('button', { name: i18n.ts._chat._channels.create }) as HTMLButtonElement).disabled).toBe(true);
	expect(mocks.api).not.toHaveBeenCalled();
});

test('counts names in code points and preserves internal whitespace', async () => {
	mocks.inputText.mockResolvedValueOnce({ canceled: false, result: '😀'.repeat(128) });
	const view = render(Management, { props: { room: { ...room, hasChannels: true }, channels }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat._channels.create }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/channels/create', { roomId: 'r', name: '😀'.repeat(128) }));
	view.unmount();

	mocks.api.mockClear();
	mocks.inputText.mockResolvedValueOnce({ canceled: false, result: 'x'.repeat(129) });
	render(Management, { props: { room: { ...room, hasChannels: true }, channels }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat._channels.create }));
	await waitFor(() => expect(mocks.alert).toHaveBeenCalledWith({ type: 'error', text: i18n.ts._chat._channels.nameLimit }));
	expect(mocks.api).not.toHaveBeenCalled();
});

test('rechecks archive and owner state after a pending confirmation', async () => {
	let finish!: (value: { canceled: boolean }) => void;
	mocks.confirm.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
	const view = render(Management, { props: { room }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat._channels.convert }));
	await view.rerender({ room: { ...room, isArchived: true } });
	finish({ canceled: false });
	await Promise.resolve();

	expect(mocks.api).not.toHaveBeenCalled();
});
