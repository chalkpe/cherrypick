/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type pg from 'pg';
import { expect, test, vi } from 'vitest';
import { withAdmission } from '@/core/voice-relay/admission.js';

test('lifecycle admission is FIFO, bounded, expires and releases its budget', async () => {
 const pool = { options: { max: 3 } } as pg.Pool;
 let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const order: number[] = [];
 const reject = () => new Error('RATE_LIMITED');
 vi.useFakeTimers();
 try {
  const first = withAdmission(pool, reject, async () => { await gate; }, true);
  const queued = Array.from({ length: 64 }, (_, i) => withAdmission(pool, reject, async () => { order.push(i); }, true));
  const settled = Promise.allSettled(queued);
  await expect(withAdmission(pool, reject, async () => {}, true)).rejects.toThrow('RATE_LIMITED');
  await expect(withAdmission(pool, reject, async () => {})).rejects.toThrow('RATE_LIMITED');
  release(); await first; expect((await settled).every(result => result.status === 'fulfilled')).toBe(true);
  expect(order).toEqual(Array.from({ length: 64 }, (_, i) => i));
  let unlock!: () => void;
  const held = withAdmission(pool, reject, () => new Promise<void>(resolve => { unlock = resolve; }), true);
  const expired = withAdmission(pool, reject, async () => {}, true).catch(error => error);
  await vi.advanceTimersByTimeAsync(10000);
  expect(await expired).toMatchObject({ message: 'RATE_LIMITED' });
  unlock(); await held;
  await expect(withAdmission(pool, reject, async () => 'recovered')).resolves.toBe('recovered');
 } finally { release(); vi.useRealTimers(); }
});
