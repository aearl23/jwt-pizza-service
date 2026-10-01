const { StatusCodeError, asyncHandler } = require('../src/endpointHelper');

describe('endpointHelper', () => {
  test('StatusCodeError carries statusCode', () => {
    const err = new StatusCodeError('nope', 418);
    expect(err.message).toBe('nope');
    expect(err.statusCode).toBe(418);
  });

  test('asyncHandler forwards rejected promises to next', async () => {
    const err = new Error('boom');
    const fn = asyncHandler(async () => {
      throw err;
    });
    const next = jest.fn();
    await fn({}, {}, next);
    expect(next).toHaveBeenCalledWith(err);
  });

  test('asyncHandler resolves without calling next on success', async () => {
    const fn = asyncHandler(async (_req, res) => {
      res.send('ok');
    });
    const res = { send: jest.fn() };
    const next = jest.fn();
    await fn({}, res, next);
    expect(res.send).toHaveBeenCalledWith('ok');
    expect(next).not.toHaveBeenCalled();
  });
});
