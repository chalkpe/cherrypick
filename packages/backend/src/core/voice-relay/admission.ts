/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';

type Budget = { active: number; waiters: Array<() => void> };
const budgets = new WeakMap<Pool, Budget>();
const context = new AsyncLocalStorage<{ pool: Pool; active: boolean }[]>();

export async function withAdmission<T>(pool: Pool, rejected: () => Error, run: () => Promise<T>, wait = false): Promise<T> {
 const current = context.getStore() ?? [];
 if (current.some(entry => entry.pool === pool && entry.active)) return run();
 const limit = Math.max(0, (pool.options.max ?? 10) - 2);
 let budget = budgets.get(pool);
 if (!budget) { budget = { active: 0, waiters: [] }; budgets.set(pool, budget); }
 if (limit === 0) throw rejected();
 if (budget.active >= limit || budget.waiters.length) {
  if (!wait || budget.waiters.length >= 64) throw rejected();
  const queuedBudget = budget;
  await new Promise<void>((resolve, reject) => {
   const ready = () => { clearTimeout(timer); resolve(); };
   const timer = setTimeout(() => {
    const index = queuedBudget.waiters.indexOf(ready);
    if (index >= 0) queuedBudget.waiters.splice(index, 1);
    reject(rejected());
   }, 10000);
   queuedBudget.waiters.push(ready);
  });
 } else budget.active++;
 const entry = { pool, active: true };
 try { return await context.run([...current, entry], run); } finally {
  entry.active = false;
  const next = budget.waiters.shift();
  if (next) next(); else budget.active--;
 }
}
