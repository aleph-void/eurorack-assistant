import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb, createUser, fakeBackend, insertModule } from './helpers.js';
import {
  budgetStatus,
  exhaustedUserIds,
  getBudgetSettings,
  limitFor,
  recordUsage,
} from '../src/services/budgets.js';
import { setConfig } from '../src/services/config.js';
import { createWorker, enqueueJob } from '../src/jobs/worker.js';

// One run's worth of spending, attributed to a user.
async function spend(db, userId, tokens, extra = {}) {
  return recordUsage(
    db,
    {
      provider: 'claude',
      model: 'claude-opus-5',
      input_tokens: tokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
      total_tokens: tokens,
      cost_usd: 0.5,
      ...extra,
    },
    { userId }
  );
}

describe('budget arithmetic', () => {
  it('ships with no ceiling on anybody', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const settings = await getBudgetSettings(db);
    expect(settings.limit).toBe(0);
    expect(limitFor(user, settings)).toBe(0);
    expect((await budgetStatus(db, user)).unlimited).toBe(true);
    // Nothing to enforce means nothing to look up.
    expect(await exhaustedUserIds(db)).toEqual(new Set());
  });

  it('prefers a user’s own allowance over the default, and 0 means unlimited', async () => {
    const db = await createTestDb();
    await setConfig(db, { token_budget_default: 1000 });
    const settings = await getBudgetSettings(db);
    expect(limitFor({ id: 1, token_budget: null }, settings)).toBe(1000);
    expect(limitFor({ id: 2, token_budget: 50 }, settings)).toBe(50);
    expect(limitFor({ id: 3, token_budget: 0 }, settings)).toBe(0);
    // Admins are exempt: the app that raises a budget is the app that needs
    // to still be usable when one runs out.
    expect(limitFor({ id: 4, is_admin: true, token_budget: 10 }, settings)).toBe(0);
  });

  it('counts the tokens spent inside the window and forgets the ones outside it', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    await setConfig(db, { token_budget_default: 1000, token_budget_period: 'day' });

    await spend(db, user.id, 400);
    const old = await spend(db, user.id, 900);
    // Backdated past the window: two days ago is not this day's spending.
    // (Written in SQL — Sequelize will not let a row's createdAt be moved.)
    await db.query('UPDATE llm_usage SET created_at = $1 WHERE id = $2', [
      new Date(Date.now() - 48 * 60 * 60 * 1000),
      old.id,
    ]);

    const status = await budgetStatus(db, user);
    expect(status.used).toBe(400);
    expect(status.remaining).toBe(600);
    expect(status.exhausted).toBe(false);
    expect(status.period).toBe('day');
    expect(status.cost_usd).toBeCloseTo(0.5);

    await spend(db, user.id, 600);
    expect((await budgetStatus(db, user)).exhausted).toBe(true);
  });

  it('names only the users who are actually out', async () => {
    const db = await createTestDb();
    const alice = await createUser(db, { username: 'alice' });
    const bob = await createUser(db, { username: 'bob' });
    const admin = await createUser(db, { username: 'admin', isAdmin: true });
    await setConfig(db, { token_budget_default: 100 });

    await spend(db, alice.id, 150);
    await spend(db, bob.id, 20);
    await spend(db, admin.id, 9999);

    expect(await exhaustedUserIds(db)).toEqual(new Set([alice.id]));
  });

  it('records nothing for a run that reported nothing', async () => {
    const db = await createTestDb();
    expect(await recordUsage(db, null, { userId: 1 })).toBeNull();
    expect(await db.models.LlmUsage.count()).toBe(0);
  });
});

describe('budgets and the queue', () => {
  it('holds the jobs of a user who is out and runs everybody else’s', async () => {
    const db = await createTestDb();
    const alice = await createUser(db, { username: 'alice' });
    const bob = await createUser(db, { username: 'bob' });
    await setConfig(db, { token_budget_default: 100 });
    await spend(db, alice.id, 500);

    // Alice's job is first in the queue; Bob's should still run.
    const aliceJob = await enqueueJob(db, 'import', {
      userId: alice.id,
      payload: { type: 'text', content: 'Make Noise, Maths', rack: 'main rack' },
    });
    const bobJob = await enqueueJob(db, 'import', {
      userId: bob.id,
      payload: { type: 'text', content: 'ALM, Pam', rack: 'main rack' },
    });

    const worker = createWorker(db, {
      backendFactory: () => fakeBackend({}),
      // The held set is normally reused for a couple of seconds; this test
      // changes a budget between ticks and wants the next one to see it.
      budgetCacheMs: 0,
      log: () => {},
    });
    await worker.tick();

    expect((await db.models.Job.findByPk(aliceJob.id)).status).toBe('pending');
    expect((await db.models.Job.findByPk(bobJob.id)).status).toBe('complete');

    // The hold lifts on its own once the window has rolled forward.
    await db.models.LlmUsage.update(
      { created_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
      { where: { user_id: alice.id } }
    );
    await worker.tick();
    expect((await db.models.Job.findByPk(aliceJob.id)).status).toBe('complete');
  });

  it('bills every run a job makes to the user who caused it', async () => {
    const db = await createTestDb();
    const alice = await createUser(db, { username: 'alice' });
    const module = await insertModule(db, alice.id, { analysis_status: 'pending' });

    // A backend that reports usage the way the real one does.
    const backend = fakeBackend({ completeText: '{"summary": "x", "components": []}' });
    const job = await enqueueJob(db, 'analyze_manual', {
      userId: alice.id,
      moduleId: module.id,
    });
    const worker = createWorker(db, {
      backendFactory: (settings, deps = {}) => {
        deps.onUsage?.({
          provider: 'claude',
          model: 'claude-opus-5',
          input_tokens: 10,
          cache_read_tokens: 1,
          cache_write_tokens: 2,
          output_tokens: 3,
          total_tokens: 16,
          cost_usd: 0.02,
        });
        return backend;
      },
      log: () => {},
    });
    await worker.tick();

    const rows = await db.models.LlmUsage.findAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].get({ plain: true })).toMatchObject({
      user_id: alice.id,
      job_id: job.id,
      job_type: 'analyze_manual',
      provider: 'claude',
      model: 'claude-opus-5',
      total_tokens: 16,
    });
  });
});

describe('usage API', () => {
  it('tells a user where they stand', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    await setConfig(db, { token_budget_default: 1000 });
    await spend(db, rows[0].id, 250);

    const res = await request(app).get('/api/usage/me').set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      limit: 1000,
      used: 250,
      remaining: 750,
      exhausted: false,
      unlimited: false,
      period: 'month',
    });
  });

  it('refuses new work once the allowance is gone, and says why', async () => {
    const { app, db, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    await insertModule(db, rows[0].id);
    await setConfig(db, { token_budget_default: 100 });
    await spend(db, rows[0].id, 100);

    const res = await request(app)
      .post('/api/questions')
      .set('Cookie', aliceCookie)
      .send({ prompt: 'What does it do?' });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/Token budget spent/);
    expect(res.body.budget.exhausted).toBe(true);
    // Nothing was queued.
    expect(await db.models.Job.count()).toBe(0);

    const imported = await request(app)
      .post('/api/imports')
      .set('Cookie', aliceCookie)
      .send({ type: 'text', content: 'Make Noise, Maths' });
    expect(imported.status).toBe(429);
  });

  it('lets an admin see and change what each user may spend', async () => {
    const { app, db, adminCookie, aliceCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id, username FROM users ORDER BY id");
    const alice = rows.find((u) => u.username === 'alice');
    await setConfig(db, { token_budget_default: 1000 });
    await spend(db, alice.id, 300);

    const overview = await request(app).get('/api/usage').set('Cookie', adminCookie);
    expect(overview.status).toBe(200);
    expect(overview.body.default_limit).toBe(1000);
    expect(overview.body.total_tokens).toBe(300);
    const row = overview.body.users.find((u) => u.username === 'alice');
    expect(row).toMatchObject({ used: 300, limit: 1000, remaining: 700, exhausted: false });

    const runs = await request(app).get('/api/usage/runs').set('Cookie', adminCookie);
    expect(runs.body[0]).toMatchObject({ username: 'alice', total_tokens: 300 });

    const raised = await request(app)
      .put(`/api/users/${alice.id}/budget`)
      .set('Cookie', adminCookie)
      .send({ token_budget: 50 });
    expect(raised.status).toBe(200);
    expect(raised.body.token_budget).toBe(50);
    expect((await request(app).get('/api/usage/me').set('Cookie', aliceCookie)).body).toMatchObject({
      limit: 50,
      exhausted: true,
    });

    // Cleared, and they are back on the default.
    await request(app)
      .put(`/api/users/${alice.id}/budget`)
      .set('Cookie', adminCookie)
      .send({ token_budget: null });
    expect((await request(app).get('/api/usage/me').set('Cookie', aliceCookie)).body.limit).toBe(1000);
  });

  it('keeps the overview and the allowance to admins', async () => {
    const { app, aliceCookie } = await createTestApp();
    expect((await request(app).get('/api/usage').set('Cookie', aliceCookie)).status).toBe(403);
    expect(
      (await request(app).put('/api/users/1/budget').set('Cookie', aliceCookie).send({})).status
    ).toBe(403);
  });

  it('validates the budget it is given', async () => {
    const { app, db, adminCookie } = await createTestApp();
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
    const res = await request(app)
      .put(`/api/users/${rows[0].id}/budget`)
      .set('Cookie', adminCookie)
      .send({ token_budget: -5 });
    expect(res.status).toBe(400);
    const bad = await request(app)
      .put('/api/config')
      .set('Cookie', adminCookie)
      .send({ token_budget_period: 'fortnight' });
    expect(bad.status).toBe(400);
  });
});
