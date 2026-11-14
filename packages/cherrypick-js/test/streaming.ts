import { describe, test, expect, afterEach } from 'vitest';
import WS from 'vitest-websocket-mock';
import Stream from '../src/streaming.js';

describe('Streaming', () => {
	afterEach(() => {
		WS.clean();
	});
	test('useChannel', async () => {
		const server = new WS('wss://cherrypick.test/streaming');
		const stream = new Stream('https://cherrypick.test', { token: 'TOKEN' });
		const mainChannelReceived: any[] = [];
		const main = stream.useChannel('main');
		main.on('meUpdated', payload => {
			mainChannelReceived.push(payload);
		});

		const ws = await server.connected;
		expect(new URLSearchParams(new URL(ws.url).search).get('i')).toEqual('TOKEN');

		const msg = JSON.parse(await server.nextMessage as string);
		const mainChannelId = msg.body.id;
		expect(msg.type).toEqual('connect');
		expect(msg.body.channel).toEqual('main');
		expect(mainChannelId != null).toEqual(true);

		server.send(JSON.stringify({
			type: 'channel',
			body: {
				id: mainChannelId,
				type: 'meUpdated',
				body: {
					id: 'foo'
				}
			}
		}));

		expect(mainChannelReceived[0]).toEqual({
			id: 'foo'
		});

		stream.close();
		server.close();
	});

	test('useChannel with parameters', async () => {
		const server = new WS('wss://cherrypick.test/streaming');
		const stream = new Stream('https://cherrypick.test', { token: 'TOKEN' });
		const chatChannelReceived: any[] = [];
		const chat = stream.useChannel('chat', { other: 'aaa' });
		chat.on('message', payload => {
			chatChannelReceived.push(payload);
		});

		const ws = await server.connected;
		expect(new URLSearchParams(new URL(ws.url).search).get('i')).toEqual('TOKEN');

		const msg = JSON.parse(await server.nextMessage as string);
		const chatChannelId = msg.body.id;
		expect(msg.type).toEqual('connect');
		expect(msg.body.channel).toEqual('chat');
		expect(msg.body.params).toEqual({ other: 'aaa' });
		expect(chatChannelId != null).toEqual(true);

		server.send(JSON.stringify({
			type: 'channel',
			body: {
				id: chatChannelId,
				type: 'message',
				body: {
					id: 'foo'
				}
			}
		}));

		expect(chatChannelReceived[0]).toEqual({
			id: 'foo'
		});

		stream.close();
		server.close();
	});

	test('ちゃんとチャンネルごとにidが異なる', async () => {
		const server = new WS('wss://cherrypick.test/streaming');
		const stream = new Stream('https://cherrypick.test', { token: 'TOKEN' });

		stream.useChannel('chat', { other: 'aaa' });
		stream.useChannel('chat', { other: 'bbb' });

		const ws = await server.connected;
		expect(new URLSearchParams(new URL(ws.url).search).get('i')).toEqual('TOKEN');

		const msg = JSON.parse(await server.nextMessage as string);
		const chatChannelId = msg.body.id;
		const msg2 = JSON.parse(await server.nextMessage as string);
		const chatChannelId2 = msg2.body.id;

		expect(chatChannelId != null).toEqual(true);
		expect(chatChannelId2 != null).toEqual(true);
		expect(chatChannelId).not.toEqual(chatChannelId2);

		stream.close();
		server.close();
	});

	test('Connection#send', async () => {
		const server = new WS('wss://cherrypick.test/streaming');
		const stream = new Stream('https://cherrypick.test', { token: 'TOKEN' });

		const chat = stream.useChannel('chat', { other: 'aaa' });
		chat.send('read', { id: 'aaa' });

		const ws = await server.connected;
		expect(new URLSearchParams(new URL(ws.url).search).get('i')).toEqual('TOKEN');

		const connectMsg = JSON.parse(await server.nextMessage as string);
		const channelId = connectMsg.body.id;
		const msg = JSON.parse(await server.nextMessage as string);

		expect(msg.type).toEqual('ch');
		expect(msg.body.id).toEqual(channelId);
		expect(msg.body.type).toEqual('read');
		expect(msg.body.body).toEqual({ id: 'aaa' });

		stream.close();
		server.close();
	});

	test('Connection#dispose', async () => {
		const server = new WS('wss://cherrypick.test/streaming');
		const stream = new Stream('https://cherrypick.test', { token: 'TOKEN' });
		const mainChannelReceived: any[] = [];
		const main = stream.useChannel('main');
		main.on('meUpdated', payload => {
			mainChannelReceived.push(payload);
		});

		const ws = await server.connected;
		expect(new URLSearchParams(new URL(ws.url).search).get('i')).toEqual('TOKEN');

		const msg = JSON.parse(await server.nextMessage as string);
		const mainChannelId = msg.body.id;
		expect(msg.type).toEqual('connect');
		expect(msg.body.channel).toEqual('main');
		expect(mainChannelId != null).toEqual(true);
		main.dispose();

		server.send(JSON.stringify({
			type: 'channel',
			body: {
				id: mainChannelId,
				type: 'meUpdated',
				body: {
					id: 'foo'
				}
			}
		}));

		expect(mainChannelReceived.length).toEqual(0);

		stream.close();
		server.close();
	});

	test('tells a channel with parameters when the server has subscribed it', async () => {
		const server = new WS('wss://cherrypick.test/streaming');
		const stream = new Stream('https://cherrypick.test', { token: 'TOKEN' });
		let subscribed = 0;
		let otherSubscribed = 0;
		const room = stream.useChannel('chatRoom', { roomId: 'r1' });
		room.on('_subscribed_', () => { subscribed++; });
		const other = stream.useChannel('chatRoom', { roomId: 'r2' });
		other.on('_subscribed_', () => { otherSubscribed++; });

		await server.connected;
		const msg = JSON.parse(await server.nextMessage as string);
		expect(msg.type).toEqual('connect');
		expect(msg.body.params).toEqual({ roomId: 'r1' });
		// The server answers only when asked to.
		expect(msg.body.pong).toEqual(true);
		await server.nextMessage;

		expect(subscribed).toEqual(0);
		server.send(JSON.stringify({ type: 'connected', body: { id: msg.body.id } }));
		expect(subscribed).toEqual(1);
		expect(otherSubscribed).toEqual(0);

		stream.close();
		server.close();
	});

	test('tells a shared channel when the server has subscribed it', async () => {
		const server = new WS('wss://cherrypick.test/streaming');
		const stream = new Stream('https://cherrypick.test', { token: 'TOKEN' });
		let subscribed = 0;
		const main = stream.useChannel('main');
		main.on('_subscribed_', () => { subscribed++; });

		await server.connected;
		const msg = JSON.parse(await server.nextMessage as string);
		expect(msg.type).toEqual('connect');
		expect(msg.body.channel).toEqual('main');

		expect(subscribed).toEqual(0);
		server.send(JSON.stringify({ type: 'connected', body: { id: msg.body.id } }));
		expect(subscribed).toEqual(1);

		stream.close();
		server.close();
	});

	test('asks the server to acknowledge a shared channel subscription', async () => {
		const server = new WS('wss://cherrypick.test/streaming');
		const stream = new Stream('https://cherrypick.test', { token: 'TOKEN' });
		stream.useChannel('main');

		await server.connected;
		const msg = JSON.parse(await server.nextMessage as string);
		expect(msg.type).toEqual('connect');
		expect(msg.body.channel).toEqual('main');
		// The server answers only when asked to, just like for channels with parameters.
		expect(msg.body.pong).toEqual(true);

		stream.close();
		server.close();
	});

	test('tells a shared connection that joins an already subscribed pool', async () => {
		const server = new WS('wss://cherrypick.test/streaming');
		const stream = new Stream('https://cherrypick.test', { token: 'TOKEN' });
		const first = stream.useChannel('main');
		let firstSubscribed = 0;
		first.on('_subscribed_', () => { firstSubscribed++; });

		await server.connected;
		const msg = JSON.parse(await server.nextMessage as string);
		server.send(JSON.stringify({ type: 'connected', body: { id: msg.body.id } }));
		expect(firstSubscribed).toEqual(1);

		// The acknowledgement can arrive before a later consumer joins the pool.
		const late = stream.useChannel('main');
		let lateSubscribed = 0;
		late.on('_subscribed_', () => { lateSubscribed++; });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(lateSubscribed).toEqual(1);
		expect(firstSubscribed).toEqual(1);

		stream.close();
		server.close();
	});

	test('waits for a fresh acknowledgement after a reconnect before telling late joiners', async () => {
		const server = new WS('wss://cherrypick.test/streaming');
		const stream = new Stream('https://cherrypick.test', { token: 'TOKEN' });
		stream.useChannel('main');

		await server.connected;
		const msg = JSON.parse(await server.nextMessage as string);
		server.send(JSON.stringify({ type: 'connected', body: { id: msg.body.id } }));

		server.close();
		const server2 = new WS('wss://cherrypick.test/streaming');
		await server2.connected;
		const msg2 = JSON.parse(await server2.nextMessage as string);
		expect(msg2.type).toEqual('connect');
		expect(msg2.body.channel).toEqual('main');
		expect(msg2.body.pong).toEqual(true);

		// The old subscription died with the socket; a late joiner must not be told it is still active.
		const late = stream.useChannel('main');
		let lateSubscribed = 0;
		late.on('_subscribed_', () => { lateSubscribed++; });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(lateSubscribed).toEqual(0);

		server2.send(JSON.stringify({ type: 'connected', body: { id: msg2.body.id } }));
		expect(lateSubscribed).toEqual(1);

		stream.close();
		server2.close();
	});

	// TODO: SharedConnection#dispose して一定時間経ったら disconnect メッセージがサーバーに送られてくるかのテスト

	// TODO: チャンネル接続が使いまわされるかのテスト
});
