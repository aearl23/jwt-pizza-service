const request = require('supertest');
const app = require('../src/service');
const { DB } = require('../src/database/database');

describe('JWT Pizza Service', () => {
  let adminToken;
  let dinerToken;
  let franchiseeToken;
  let franchiseeUserId;

  beforeAll(async () => {
    await DB.initialized;
  });

  test('GET / returns welcome', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('welcome to JWT Pizza');
    expect(res.body.version).toBeDefined();
  });

  test('GET /api/docs lists endpoints', async () => {
    const res = await request(app).get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.body.endpoints.length).toBeGreaterThan(0);
    expect(res.body.config.factory).toBeDefined();
  });

  test('unknown route returns 404', async () => {
    const res = await request(app).get('/api/not-real');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('unknown endpoint');
  });

  test('POST /api/auth requires name, email, and password', async () => {
    const res = await request(app).post('/api/auth').send({ email: 'x@jwt.com' });
    expect(res.status).toBe(400);
  });

  test('register diner and login', async () => {
    const register = await request(app)
      .post('/api/auth')
      .send({ name: 'pizza diner', email: 'd@jwt.com', password: 'diner' });
    expect(register.status).toBe(200);
    expect(register.body.token).toBeDefined();
    dinerToken = register.body.token;

    const login = await request(app).put('/api/auth').send({ email: 'd@jwt.com', password: 'diner' });
    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe('d@jwt.com');
  });

  test('register franchisee', async () => {
    const res = await request(app)
      .post('/api/auth')
      .send({ name: 'pizza franchisee', email: 'f@jwt.com', password: 'franchisee' });
    expect(res.status).toBe(200);
    franchiseeToken = res.body.token;
    franchiseeUserId = res.body.user.id;
  });

  test('login admin', async () => {
    const res = await request(app).put('/api/auth').send({ email: 'a@jwt.com', password: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.user.roles.some((r) => r.role === 'admin')).toBe(true);
    adminToken = res.body.token;
  });

  test('login with bad password returns 404', async () => {
    const res = await request(app).put('/api/auth').send({ email: 'a@jwt.com', password: 'wrong' });
    expect(res.status).toBe(404);
  });

  test('GET /api/user/me requires auth', async () => {
    const res = await request(app).get('/api/user/me');
    expect(res.status).toBe(401);
  });

  test('GET /api/user/me returns current user', async () => {
    const res = await request(app).get('/api/user/me').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('a@jwt.com');
  });

  test('PUT /api/user/:id forbidden for other users', async () => {
    const res = await request(app)
      .put('/api/user/1')
      .set('Authorization', `Bearer ${dinerToken}`)
      .send({ name: 'hacker', email: 'd@jwt.com', password: 'diner' });
    expect(res.status).toBe(403);
  });

  test('admin can update user profile', async () => {
    const res = await request(app)
      .put('/api/user/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '常用名字', email: 'a@jwt.com', password: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('常用名字');
    adminToken = res.body.token;
  });

  test('list users stub', async () => {
    const res = await request(app).get('/api/user').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('not implemented');
  });

  test('GET /api/order/menu', async () => {
    const res = await request(app).get('/api/order/menu');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('admin can add menu items', async () => {
    const res = await request(app)
      .put('/api/order/menu')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Veggie',
        description: 'A garden of delight',
        image: 'pizza1.png',
        price: 0.0038,
      });
    expect(res.status).toBe(200);
    expect(res.body.some((item) => item.title === 'Veggie')).toBe(true);
  });

  test('diner cannot add menu items', async () => {
    const res = await request(app)
      .put('/api/order/menu')
      .set('Authorization', `Bearer ${dinerToken}`)
      .send({
        title: 'Student',
        description: 'No topping',
        image: 'pizza9.png',
        price: 0.0001,
      });
    expect(res.status).toBe(403);
  });

  test('create franchise and store', async () => {
    const franchise = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'pizzaPocket', admins: [{ email: 'f@jwt.com' }] });
    expect(franchise.status).toBe(200);
    expect(franchise.body.id).toBeDefined();

    const store = await request(app)
      .post('/api/franchise/1/store')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ franchiseId: 1, name: 'SLC' });
    expect(store.status).toBe(200);
    expect(store.body.name).toBe('SLC');
  });

  test('list franchises', async () => {
    const res = await request(app).get('/api/franchise?page=0&limit=10&name=pizzaPocket');
    expect(res.status).toBe(200);
    expect(res.body.franchises.length).toBeGreaterThan(0);
  });

  test('admin list franchises includes franchise details', async () => {
    const res = await request(app).get('/api/franchise?page=0&limit=10&name=pizzaPocket').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.franchises[0].admins).toBeDefined();
    expect(res.body.franchises[0].stores).toBeDefined();
  });

  test('franchisee can create a store', async () => {
    const res = await request(app)
      .post('/api/franchise/1/store')
      .set('Authorization', `Bearer ${franchiseeToken}`)
      .send({ name: 'Provo' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Provo');
  });

  test('create franchise with unknown admin fails', async () => {
    const res = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'badFranchise', admins: [{ email: 'nobody@jwt.com' }] });
    expect(res.status).toBe(404);
  });

  test('diner sees empty list for another users franchises', async () => {
    const res = await request(app)
      .get(`/api/franchise/${franchiseeUserId}`)
      .set('Authorization', `Bearer ${dinerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('delete user is not implemented', async () => {
    const res = await request(app).delete('/api/user/2').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('not implemented');
  });

  test('franchisee can list their franchises', async () => {
    const res = await request(app)
      .get(`/api/franchise/${franchiseeUserId}`)
      .set('Authorization', `Bearer ${franchiseeToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test('diner cannot create franchise', async () => {
    const res = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${dinerToken}`)
      .send({ name: 'failFranchise', admins: [{ email: 'f@jwt.com' }] });
    expect(res.status).toBe(403);
  });

  test('create order and list orders', async () => {
    const order = await request(app)
      .post('/api/order')
      .set('Authorization', `Bearer ${dinerToken}`)
      .send({
        franchiseId: 1,
        storeId: 1,
        items: [{ menuId: 1, description: 'Veggie', price: 0.05 }],
      });
    expect(order.status).toBe(200);
    expect(order.body.jwt).toBeDefined();

    const orders = await request(app).get('/api/order').set('Authorization', `Bearer ${dinerToken}`);
    expect(orders.status).toBe(200);
    expect(orders.body.orders.length).toBeGreaterThan(0);
  });

  test('delete store and franchise', async () => {
    const delStore = await request(app)
      .delete('/api/franchise/1/store/1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(delStore.status).toBe(200);

    const delFranchise = await request(app).delete('/api/franchise/1');
    expect(delFranchise.status).toBe(200);
  });

  test('logout', async () => {
    const res = await request(app).delete('/api/auth').set('Authorization', `Bearer ${dinerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('logout successful');

    const me = await request(app).get('/api/user/me').set('Authorization', `Bearer ${dinerToken}`);
    expect(me.status).toBe(401);
  });
});
