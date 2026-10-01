const request = require('supertest');
const app = require('../src/service');
const { DB } = require('../src/database/database');

async function registerOrLogin(name, email, password) {
  const login = await request(app).put('/api/auth').send({ email, password });
  if (login.status === 200) {
    return login;
  }
  return request(app).post('/api/auth').send({ name, email, password });
}

describe('JWT Pizza Service', () => {
  let adminToken;
  let adminUserId;
  let dinerToken;
  let dinerUserId;
  let franchiseeToken;
  let franchiseeUserId;
  let franchiseId;
  let storeId;
  let menuId;
  const franchiseName = `pizzaPocket${Date.now()}`;

  beforeAll(async () => {
    await DB.initialized;
    const admin = await registerOrLogin('常用名字', 'a@jwt.com', 'admin');
    if (admin.status !== 200) {
      throw new Error(`Admin setup failed (${admin.status}): ${JSON.stringify(admin.body)}`);
    }
    adminToken = admin.body.token;
    adminUserId = admin.body.user.id;
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
    const register = await registerOrLogin('pizza diner', 'd@jwt.com', 'diner');
    expect(register.status).toBe(200);
    expect(register.body.token).toBeDefined();
    dinerToken = register.body.token;
    dinerUserId = register.body.user.id;

    const login = await request(app).put('/api/auth').send({ email: 'd@jwt.com', password: 'diner' });
    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe('d@jwt.com');
  });

  test('register franchisee', async () => {
    const res = await registerOrLogin('pizza franchisee', 'f@jwt.com', 'franchisee');
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
      .put(`/api/user/${adminUserId}`)
      .set('Authorization', `Bearer ${dinerToken}`)
      .send({ name: 'hacker', email: 'd@jwt.com', password: 'diner' });
    expect(res.status).toBe(403);
  });

  test('admin can update user profile', async () => {
    const res = await request(app)
      .put(`/api/user/${adminUserId}`)
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
    const veggie = res.body.find((item) => item.title === 'Veggie');
    expect(veggie).toBeDefined();
    menuId = veggie.id;
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
      .send({ name: franchiseName, admins: [{ email: 'f@jwt.com' }] });
    expect(franchise.status).toBe(200);
    franchiseId = franchise.body.id;

    const store = await request(app)
      .post(`/api/franchise/${franchiseId}/store`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ franchiseId, name: 'SLC' });
    expect(store.status).toBe(200);
    expect(store.body.name).toBe('SLC');
    storeId = store.body.id;
  });

  test('list franchises', async () => {
    const res = await request(app).get(`/api/franchise?page=0&limit=10&name=${franchiseName}`);
    expect(res.status).toBe(200);
    expect(res.body.franchises.length).toBeGreaterThan(0);
  });

  test('admin list franchises includes franchise details', async () => {
    const res = await request(app)
      .get(`/api/franchise?page=0&limit=10&name=${franchiseName}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.franchises[0].admins).toBeDefined();
    expect(res.body.franchises[0].stores).toBeDefined();
  });

  test('franchisee can create a store', async () => {
    const res = await request(app)
      .post(`/api/franchise/${franchiseId}/store`)
      .set('Authorization', `Bearer ${franchiseeToken}`)
      .send({ name: 'Provo' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Provo');
  });

  test('create franchise with unknown admin fails', async () => {
    const res = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `badFranchise${Date.now()}`, admins: [{ email: 'nobody@jwt.com' }] });
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
    const res = await request(app).delete(`/api/user/${dinerUserId}`).set('Authorization', `Bearer ${adminToken}`);
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
      .send({ name: `failFranchise${Date.now()}`, admins: [{ email: 'f@jwt.com' }] });
    expect(res.status).toBe(403);
  });

  test('create order and list orders', async () => {
    const order = await request(app)
      .post('/api/order')
      .set('Authorization', `Bearer ${dinerToken}`)
      .send({
        franchiseId,
        storeId,
        items: [{ menuId, description: 'Veggie', price: 0.05 }],
      });
    expect(order.status).toBe(200);
    expect(order.body.jwt).toBeDefined();

    const orders = await request(app).get('/api/order').set('Authorization', `Bearer ${dinerToken}`);
    expect(orders.status).toBe(200);
    expect(orders.body.orders.length).toBeGreaterThan(0);
  });

  test('delete store and franchise', async () => {
    const delStore = await request(app)
      .delete(`/api/franchise/${franchiseId}/store/${storeId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(delStore.status).toBe(200);

    const delFranchise = await request(app).delete(`/api/franchise/${franchiseId}`);
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
