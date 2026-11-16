/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/vue';
import type { Directive } from 'vue';
import type * as Misskey from 'cherrypick-js';

const mocks = vi.hoisted(() => ({ api: vi.fn().mockResolvedValue([]), confirm: vi.fn(), inputText: vi.fn(), select: vi.fn(), alert: vi.fn(), touch: false, me: { id: 'owner', policies: { chatAvailability: 'available' } } }));
vi.mock('@/i.js', async original => ({ ...await original<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/os.js', () => ({ confirm: mocks.confirm, inputText: mocks.inputText, select: mocks.select, alert: mocks.alert }));
vi.mock('@/utility/touch.js', () => ({ get isTouchUsing() { return mocks.touch; } }));

vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));

import Management from '@/pages/chat/room.channels.manage.vue';
import { i18n } from '@/i18n.js';

const room = { id: 'r', name: 'Group', ownerId: 'owner', isArchived: false, hasChannels: false, legacyChannelId: 'c1' } as Misskey.entities.ChatRoom;
const channels = [{ id: 'c1', roomId: 'r', name: 'same', isLegacy: true, sectionId: null }, { id: 'c2', roomId: 'r', name: 'same', isLegacy: false, sectionId: null }];
const stubs = { MkButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot/></button>' }, MkInfo: { template: '<div><slot/></div>' } };
beforeEach(() => { vi.resetAllMocks(); mocks.touch = false; mocks.confirm.mockResolvedValue({ canceled: false }); mocks.api.mockResolvedValue([]); });
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
	expect(mocks.api.mock.calls.some(([endpoint]) => endpoint !== 'chat/rooms/sections/list')).toBe(false);
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
	expect(mocks.api.mock.calls.some(([endpoint]) => endpoint !== 'chat/rooms/sections/list')).toBe(false);
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

function rowOf(container: Element, id: string): HTMLElement {
	return container.querySelector(`[data-chat-channel-id="${id}"]`) as HTMLElement;
}

function dragHandleOf(row: HTMLElement): HTMLElement {
	return within(row).getByRole('button', { name: i18n.ts.dragToReorder });
}

function dropAreaOf(row: HTMLElement, side: 'forward' | 'backward'): HTMLElement {
	const item = row.parentElement!.parentElement!;
	return (side === 'forward' ? item.firstElementChild : item.lastElementChild) as HTMLElement;
}

async function dragRow(source: HTMLElement, target: HTMLElement, side: 'forward' | 'backward' = 'backward') {
	const dataTransfer = new DataTransfer();
	await fireEvent.dragStart(dragHandleOf(source), { dataTransfer });
	await fireEvent.drop(dropAreaOf(target, side), { dataTransfer });
}

test('reorders channels by dragging one onto another and submits the full ID list', async () => {
	const view = render(Management, { props: { room: { ...room, hasChannels: true }, channels }, global: { stubs } });
	await dragRow(rowOf(view.container, 'c1'), rowOf(view.container, 'c2'), 'backward');
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/channels/reorder', { roomId: 'r', channelIds: ['c2', 'c1'] }));
});

test('does not start a drag when the room is archived', () => {
	const view = render(Management, { props: { room: { ...room, hasChannels: true, isArchived: true }, channels }, global: { stubs } });
	const handle = dragHandleOf(rowOf(view.container, 'c1')) as HTMLButtonElement;
	expect(handle.disabled).toBe(true);
	expect(handle.getAttribute('draggable')).toBe('false');
});

test('restores the server order and alerts when a drag reorder fails', async () => {
	mocks.api.mockImplementation(async (endpoint: string) => {
		if (endpoint === 'chat/rooms/channels/reorder') throw new Error('reorder failed');
		return [];
	});
	const view = render(Management, { props: { room: { ...room, hasChannels: true }, channels }, global: { stubs } });
	await dragRow(rowOf(view.container, 'c1'), rowOf(view.container, 'c2'), 'backward');
	await waitFor(() => expect(mocks.alert).toHaveBeenCalledWith({ type: 'error', text: i18n.ts._chat.actionFailed }));
	await waitFor(() => expect(view.emitted('channelsUpdated')).toHaveLength(1));
	await waitFor(() => {
		const ids = Array.from(view.container.querySelectorAll('[data-chat-channel-id]')).map(el => el.getAttribute('data-chat-channel-id'));
		expect(ids).toEqual(['c1', 'c2']);
	});
});

const sectionList = [{ id: 's1', roomId: 'r', name: '운영' }, { id: 's2', roomId: 'r', name: '행사' }];
const sectionedChannels = [
	{ id: 'c1', roomId: 'r', name: 'First', isLegacy: false, sectionId: null },
	{ id: 'c2', roomId: 'r', name: 'Second', isLegacy: false, sectionId: 's1' },
	{ id: 'c3', roomId: 'r', name: 'Third', isLegacy: false, sectionId: 's2' },
];

function mockSections(options: { sections?: unknown[]; channels?: unknown[] } = {}) {
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/sections/list' ? (options.sections ?? sectionList) : (options.channels ?? []));
}

function sectionRowOf(container: Element, id: string): HTMLElement {
	return container.querySelector(`[data-chat-manage-section-id="${id}"]`) as HTMLElement;
}

function renderSectioned(extra: Record<string, unknown> = {}, directives: Record<string, Directive> = {}) {
	mockSections();
	return render(Management, { props: { room: { ...room, hasChannels: true }, channels: sectionedChannels, ...extra }, global: { stubs, directives } });
}

test('shows section rows with their management buttons and channel rows inside sections', async () => {
	const view = renderSectioned();
	await waitFor(() => expect(sectionRowOf(view.container, 's1')).not.toBeNull());
	const section = within(sectionRowOf(view.container, 's1'));
	expect(section.getByRole('button', { name: i18n.ts._chat._channels.moveUp })).toBeTruthy();
	expect(section.getByRole('button', { name: i18n.ts._chat._channels.moveDown })).toBeTruthy();
	expect(section.getByRole('button', { name: i18n.ts._chat._channels.createChannelInSection })).toBeTruthy();
	expect(section.getByRole('button', { name: i18n.ts.rename })).toBeTruthy();
	expect(section.getByRole('button', { name: i18n.ts.delete })).toBeTruthy();
	const channel = within(rowOf(view.container, 'c2'));
	expect(channel.getByRole('button', { name: i18n.ts._chat._channels.moveSection })).toBeTruthy();
	expect(sectionRowOf(view.container, 's1').parentElement!.querySelector('[data-chat-channel-id="c2"]')).not.toBeNull();
	expect(sectionRowOf(view.container, 's2').parentElement!.querySelector('[data-chat-channel-id="c3"]')).not.toBeNull();
});

test('creates a section with trimmed name and rejects names over 128 code points', async () => {
	mocks.inputText.mockResolvedValueOnce({ canceled: false, result: '  운영  ' });
	const view = renderSectioned();
	await waitFor(() => expect(sectionRowOf(view.container, 's1')).not.toBeNull());
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat._channels.createSection }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/sections/create', { roomId: 'r', name: '운영' }));
	expect(mocks.inputText.mock.lastCall![0].title).toBe(i18n.ts._chat._channels.sectionName);
	view.unmount();

	mocks.api.mockClear();
	mocks.inputText.mockResolvedValueOnce({ canceled: false, result: 'x'.repeat(129) });
	const view2 = renderSectioned();
	await waitFor(() => expect(sectionRowOf(view2.container, 's1')).not.toBeNull());
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat._channels.createSection }));
	await waitFor(() => expect(mocks.alert).toHaveBeenCalledWith({ type: 'error', text: i18n.ts._chat._channels.sectionNameLimit }));
	expect(mocks.api.mock.calls.some(([endpoint]) => endpoint === 'chat/rooms/sections/create')).toBe(false);
});

test('renames a section and deletes it after confirmation', async () => {
	mocks.inputText.mockResolvedValueOnce({ canceled: false, result: '새 이름' });
	const view = renderSectioned();
	await waitFor(() => expect(sectionRowOf(view.container, 's1')).not.toBeNull());
	await fireEvent.click(within(sectionRowOf(view.container, 's1')).getByRole('button', { name: i18n.ts.rename }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/sections/update', { sectionId: 's1', name: '새 이름' }));

	await waitFor(() => expect((within(sectionRowOf(view.container, 's1')).getByRole('button', { name: i18n.ts.delete }) as HTMLButtonElement).disabled).toBe(false));
	await fireEvent.click(within(sectionRowOf(view.container, 's1')).getByRole('button', { name: i18n.ts.delete }));
	await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
	expect(mocks.confirm.mock.lastCall![0].text).toBe(`${i18n.tsx._chat._channels.deleteSectionConfirm({ name: '운영' })}\n${i18n.ts._chat._channels.deleteSectionChannelsNotice}`);
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/sections/delete', { sectionId: 's1' }));
});

test('creates a channel inside the section from its row', async () => {
	mocks.inputText.mockResolvedValueOnce({ canceled: false, result: '자료' });
	const view = renderSectioned();
	await waitFor(() => expect(sectionRowOf(view.container, 's1')).not.toBeNull());
	await fireEvent.click(within(sectionRowOf(view.container, 's1')).getByRole('button', { name: i18n.ts._chat._channels.createChannelInSection }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/channels/create', { roomId: 'r', name: '자료', sectionId: 's1' }));
});

test('moves a channel to another section through the select and appends it there', async () => {
	mocks.select.mockResolvedValueOnce({ canceled: false, result: 's2' });
	const view = renderSectioned();
	await waitFor(() => expect(rowOf(view.container, 'c2')).not.toBeNull());
	await fireEvent.click(within(rowOf(view.container, 'c2')).getByRole('button', { name: i18n.ts._chat._channels.moveSection }));
	await waitFor(() => expect(mocks.select).toHaveBeenCalled());
	const items = mocks.select.mock.lastCall![0].items as { value: string; label: string }[];
	expect(items[0]).toEqual({ value: '', label: i18n.ts._chat._channels.noSection });
	expect(items.some(item => item.value === 's1' && item.label === '운영')).toBe(true);
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/channels/arrange', {
		roomId: 'r',
		ungrouped: ['c1'],
		sections: [{ sectionId: 's1', channelIds: [] }, { sectionId: 's2', channelIds: ['c3', 'c2'] }],
	}));
});

test('moves a channel up and down within its own section only', async () => {
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/sections/list' ? [{ id: 's1', roomId: 'r', name: '운영' }] : []);
	const two = [
		{ id: 'c1', roomId: 'r', name: 'First', isLegacy: false, sectionId: null },
		{ id: 'c2', roomId: 'r', name: 'Second', isLegacy: false, sectionId: 's1' },
		{ id: 'c3', roomId: 'r', name: 'Third', isLegacy: false, sectionId: 's1' },
	];
	const view = render(Management, { props: { room: { ...room, hasChannels: true }, channels: two }, global: { stubs } });
	await waitFor(() => expect(rowOf(view.container, 'c2')).not.toBeNull());
	await fireEvent.click(within(rowOf(view.container, 'c2')).getByRole('button', { name: i18n.ts._chat._channels.moveDown }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/channels/arrange', {
		roomId: 'r',
		ungrouped: ['c1'],
		sections: [{ sectionId: 's1', channelIds: ['c3', 'c2'] }],
	}));
});

test('reorders sections with the up and down buttons', async () => {
	const view = renderSectioned();
	await waitFor(() => expect(sectionRowOf(view.container, 's1')).not.toBeNull());
	await fireEvent.click(within(sectionRowOf(view.container, 's1')).getByRole('button', { name: i18n.ts._chat._channels.moveDown }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/channels/arrange', {
		roomId: 'r',
		ungrouped: ['c1'],
		sections: [{ sectionId: 's2', channelIds: ['c3'] }, { sectionId: 's1', channelIds: ['c2'] }],
	}));
});

test('drags a channel across sections with a single arrange request', async () => {
	const view = renderSectioned();
	await waitFor(() => expect(rowOf(view.container, 'c2')).not.toBeNull());
	await dragRow(rowOf(view.container, 'c2'), rowOf(view.container, 'c3'), 'backward');
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/channels/arrange', {
		roomId: 'r',
		ungrouped: ['c1'],
		sections: [{ sectionId: 's1', channelIds: [] }, { sectionId: 's2', channelIds: ['c3', 'c2'] }],
	}));
	expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/channels/arrange')).toHaveLength(1);
});

test('drags a section by its handle to reorder sections with a single arrange request', async () => {
	const view = renderSectioned();
	await waitFor(() => expect(sectionRowOf(view.container, 's1')).not.toBeNull());
	const source = sectionRowOf(view.container, 's1');
	const target = sectionRowOf(view.container, 's2');
	const handle = within(source).getAllByRole('button', { name: i18n.ts.dragToReorder })[0];
	const targetItem = target.parentElement!.parentElement!.parentElement!;
	const dataTransfer = new DataTransfer();
	await fireEvent.dragStart(handle, { dataTransfer });
	await fireEvent.drop(targetItem.lastElementChild!, { dataTransfer });
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/channels/arrange', {
		roomId: 'r',
		ungrouped: ['c1'],
		sections: [{ sectionId: 's2', channelIds: ['c3'] }, { sectionId: 's1', channelIds: ['c2'] }],
	}));
	expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/channels/arrange')).toHaveLength(1);
});

test('disables every management control while the room is archived', async () => {
	const view = renderSectioned({ room: { ...room, hasChannels: true, isArchived: true } });
	await waitFor(() => expect(sectionRowOf(view.container, 's1')).not.toBeNull());
	const buttons = screen.getAllByRole('button') as HTMLButtonElement[];
	expect(buttons.length).toBeGreaterThan(0);
	for (const button of buttons) expect(button.disabled).toBe(true);
});

test('restores the server state and alerts when an arrange fails', async () => {
	mocks.api.mockImplementation(async (endpoint: string) => {
		if (endpoint === 'chat/rooms/sections/list') return sectionList;
		if (endpoint === 'chat/rooms/channels/arrange') throw new Error('arrange failed');
		return [];
	});
	const view = render(Management, { props: { room: { ...room, hasChannels: true }, channels: sectionedChannels }, global: { stubs } });
	await waitFor(() => expect(rowOf(view.container, 'c2')).not.toBeNull());
	await dragRow(rowOf(view.container, 'c2'), rowOf(view.container, 'c3'), 'backward');
	await waitFor(() => expect(mocks.alert).toHaveBeenCalledWith({ type: 'error', text: i18n.ts._chat.actionFailed }));
	await waitFor(() => expect(view.emitted('channelsUpdated')).toBeTruthy());
	await waitFor(() => {
		expect(sectionRowOf(view.container, 's1').parentElement!.querySelector('[data-chat-channel-id="c2"]')).not.toBeNull();
		expect(sectionRowOf(view.container, 's2').parentElement!.querySelector('[data-chat-channel-id="c3"]')).not.toBeNull();
	});
});

test('limits sections to 128 and shows the limit notice', async () => {
	const many = Array.from({ length: 128 }, (_, index) => ({ id: `s${index}`, roomId: 'r', name: `묶음 ${index}` }));
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/sections/list' ? many : []);
	const view = render(Management, { props: { room: { ...room, hasChannels: true }, channels: sectionedChannels }, global: { stubs } });
	await waitFor(() => expect(sectionRowOf(view.container, 's0')).not.toBeNull());
	expect((screen.getByRole('button', { name: i18n.ts._chat._channels.createSection }) as HTMLButtonElement).disabled).toBe(true);
	expect(screen.getByText(i18n.ts._chat._channels.sectionLimit)).toBeTruthy();
});

function emptyChannelAreaOf(container: Element, sectionId: string): HTMLElement {
	const block = sectionRowOf(container, sectionId).parentElement!;
	const inner = [...block.children].find(el => !el.hasAttribute('data-chat-manage-section-id'))!;
	return inner.firstElementChild as HTMLElement;
}

const withEmptySection = [
	{ id: 'c1', roomId: 'r', name: 'First', isLegacy: false, sectionId: null },
	{ id: 'c2', roomId: 'r', name: 'Second', isLegacy: false, sectionId: 's1' },
];

test('섹션 삭제 확인은 채널이 든 섹션에만 안의 채널 이동 안내를 덧붙인다', async () => {
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/sections/list' ? sectionList : []);
	const view = render(Management, { props: { room: { ...room, hasChannels: true }, channels: withEmptySection }, global: { stubs } });
	await waitFor(() => expect(sectionRowOf(view.container, 's1')).not.toBeNull());

	await fireEvent.click(within(sectionRowOf(view.container, 's1')).getByRole('button', { name: i18n.ts.delete }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/sections/delete', { sectionId: 's1' }));
	expect(mocks.confirm.mock.lastCall![0].text).toBe(`${i18n.tsx._chat._channels.deleteSectionConfirm({ name: '운영' })}\n${i18n.ts._chat._channels.deleteSectionChannelsNotice}`);

	await fireEvent.click(within(sectionRowOf(view.container, 's2')).getByRole('button', { name: i18n.ts.delete }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/sections/delete', { sectionId: 's2' }));
	expect(mocks.confirm.mock.lastCall![0].text).toBe(i18n.tsx._chat._channels.deleteSectionConfirm({ name: '행사' }));
});

test('섹션 머리글을 빈 섹션의 채널 놓기 영역에 놓으면 무시하고 요청하지 않는다', async () => {
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/sections/list' ? sectionList : []);
	const view = render(Management, { props: { room: { ...room, hasChannels: true }, channels: withEmptySection }, global: { stubs } });
	await waitFor(() => expect(sectionRowOf(view.container, 's2')).not.toBeNull());
	const handle = within(sectionRowOf(view.container, 's1')).getAllByRole('button', { name: i18n.ts.dragToReorder })[0];
	const dataTransfer = new DataTransfer();
	await fireEvent.dragStart(handle, { dataTransfer });
	await fireEvent.drop(emptyChannelAreaOf(view.container, 's2'), { dataTransfer });
	await new Promise(resolve => setTimeout(resolve, 50));
	expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/channels/arrange')).toHaveLength(0);
	expect(mocks.alert).not.toHaveBeenCalled();
	expect(sectionRowOf(view.container, 's1')).not.toBeNull();
	expect(sectionRowOf(view.container, 's2')).not.toBeNull();
});

test('채널을 빈 섹션으로 놓으면 한 번의 arrange로 옮긴다', async () => {
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/sections/list' ? sectionList : []);
	const view = render(Management, { props: { room: { ...room, hasChannels: true }, channels: withEmptySection }, global: { stubs } });
	await waitFor(() => expect(rowOf(view.container, 'c2')).not.toBeNull());
	const dataTransfer = new DataTransfer();
	await fireEvent.dragStart(dragHandleOf(rowOf(view.container, 'c2')), { dataTransfer });
	await fireEvent.drop(emptyChannelAreaOf(view.container, 's2'), { dataTransfer });
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/channels/arrange', {
		roomId: 'r',
		ungrouped: ['c1'],
		sections: [{ sectionId: 's1', channelIds: [] }, { sectionId: 's2', channelIds: ['c2'] }],
	}));
	expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/channels/arrange')).toHaveLength(1);
});

test('터치 기기에서는 관리 화면 끌기 손잡이를 숨기고 단추는 남긴다', async () => {
	mocks.touch = true;
	const view = renderSectioned();
	await waitFor(() => expect(sectionRowOf(view.container, 's1')).not.toBeNull());
	expect(screen.queryAllByRole('button', { name: i18n.ts.dragToReorder })).toHaveLength(0);
	expect(within(sectionRowOf(view.container, 's1')).getByRole('button', { name: i18n.ts._chat._channels.moveUp })).toBeTruthy();
	expect(within(sectionRowOf(view.container, 's1')).getByRole('button', { name: i18n.ts._chat._channels.createChannelInSection })).toBeTruthy();
	expect(within(rowOf(view.container, 'c2')).getByRole('button', { name: i18n.ts._chat._channels.moveSection })).toBeTruthy();
});

test('마우스를 쓰는 데스크톱에서는 관리 화면 끌기 손잡이가 있고 끌 수 있다', async () => {
	const view = renderSectioned();
	await waitFor(() => expect(sectionRowOf(view.container, 's1')).not.toBeNull());
	const handles = screen.getAllByRole('button', { name: i18n.ts.dragToReorder }) as HTMLButtonElement[];
	expect(handles.length).toBeGreaterThan(0);
	for (const handle of handles) expect(handle.getAttribute('draggable')).toBe('true');
});

test('관리 줄의 아이콘 단추는 접근성 이름과 같은 도움말을 가진다', async () => {
	const tooltip = { mounted: (el: HTMLElement, binding: { value: string }) => { el.dataset.tooltip = binding.value; } };
	const view = renderSectioned({}, { tooltip });
	await waitFor(() => expect(sectionRowOf(view.container, 's1')).not.toBeNull());
	const rows = [rowOf(view.container, 'c1'), rowOf(view.container, 'c2'), sectionRowOf(view.container, 's1'), sectionRowOf(view.container, 's2')];
	for (const row of rows) {
		const buttons = [...row.querySelectorAll('button[aria-label]')].filter(button => button.getAttribute('aria-label') !== i18n.ts.dragToReorder);
		expect(buttons.length).toBeGreaterThanOrEqual(5);
		for (const button of buttons) expect((button as HTMLElement).dataset.tooltip).toBe(button.getAttribute('aria-label'));
	}
});

function sectionDropAreaOf(container: Element, sectionId: string, side: 'forward' | 'backward'): HTMLElement {
	const item = sectionRowOf(container, sectionId).parentElement!.parentElement!.parentElement!;
	return (side === 'forward' ? item.firstElementChild : item.lastElementChild) as HTMLElement;
}

function hasDropIndicator(container: Element): boolean {
	return [...container.querySelectorAll('div')].some(el => /dropReady/.test(el.className));
}

test('채널 끌기를 섹션 제목 줄 위에 올려도 놓기 표시선을 그리지 않는다', async () => {
	const view = renderSectioned();
	await waitFor(() => expect(rowOf(view.container, 'c2')).not.toBeNull());
	const area = sectionDropAreaOf(view.container, 's2', 'forward');
	const before = area.className;
	const dataTransfer = new DataTransfer();
	await fireEvent.dragStart(dragHandleOf(rowOf(view.container, 'c2')), { dataTransfer });
	await fireEvent.dragOver(area, { dataTransfer });
	await waitFor(() => expect(area.className).toBe(before));
	expect(hasDropIndicator(view.container)).toBe(false);
});

test('섹션 끌기를 채널 행 위에 올려도 놓기 표시선을 그리지 않는다', async () => {
	const view = renderSectioned();
	await waitFor(() => expect(sectionRowOf(view.container, 's1')).not.toBeNull());
	const area = dropAreaOf(rowOf(view.container, 'c3'), 'backward');
	const before = area.className;
	const handle = within(sectionRowOf(view.container, 's1')).getAllByRole('button', { name: i18n.ts.dragToReorder })[0];
	const dataTransfer = new DataTransfer();
	await fireEvent.dragStart(handle, { dataTransfer });
	await fireEvent.dragOver(area, { dataTransfer });
	await waitFor(() => expect(area.className).toBe(before));
	expect(hasDropIndicator(view.container)).toBe(false);
});

test('같은 종류 끌기는 채널 행 위에 놓기 표시선을 그린다', async () => {
	const view = renderSectioned();
	await waitFor(() => expect(rowOf(view.container, 'c2')).not.toBeNull());
	const area = dropAreaOf(rowOf(view.container, 'c3'), 'backward');
	const before = area.className;
	const dataTransfer = new DataTransfer();
	await fireEvent.dragStart(dragHandleOf(rowOf(view.container, 'c2')), { dataTransfer });
	await fireEvent.dragOver(area, { dataTransfer });
	await waitFor(() => expect(area.className).not.toBe(before));
	expect(hasDropIndicator(view.container)).toBe(true);
});

const tooltipDirective = {
	mounted: (el: HTMLElement, binding: { value: string }) => { el.dataset.tooltip = binding.value; },
	updated: (el: HTMLElement, binding: { value: string }) => { el.dataset.tooltip = binding.value; },
};

test('마지막 채널 삭제 단추는 기존 안내 문구를 도움말로 쓰고 title을 겹치지 않는다', () => {
	const view = render(Management, { props: { room: { ...room, hasChannels: true }, channels: channels.slice(0, 1) }, global: { stubs, directives: { tooltip: tooltipDirective } } });
	const button = screen.getByRole('button', { name: i18n.ts.delete }) as HTMLButtonElement;
	expect(button.disabled).toBe(true);
	expect(button.dataset.tooltip).toBe(i18n.ts._chat._channels.lastChannel);
	expect(button.getAttribute('title')).toBeNull();
	view.unmount();
});

test('채널이 여럿이면 삭제 단추 도움말은 삭제이고 title은 없다', async () => {
	const view = renderSectioned({}, { tooltip: tooltipDirective });
	await waitFor(() => expect(rowOf(view.container, 'c1')).not.toBeNull());
	const button = within(rowOf(view.container, 'c1')).getByRole('button', { name: i18n.ts.delete }) as HTMLButtonElement;
	expect(button.dataset.tooltip).toBe(i18n.ts.delete);
	expect(button.getAttribute('title')).toBeNull();
});
