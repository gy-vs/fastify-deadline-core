'use strict'

const { test } = require('node:test')
const { connect } = require('node:net')
const Fastify = require('../fastify')
const { sleep } = require('./helper')

test('handlerTimeout is validated as a server option', t => {
  t.plan(5)

  const invalidValues = [1.5, -1, [], {}, 'foo']
  for (const value of invalidValues) {
    try {
      Fastify({ handlerTimeout: value })
      t.assert.fail(`handlerTimeout must be a positive integer, got ${value}`)
    } catch (err) {
      t.assert.strictEqual(err.code, 'FST_ERR_INIT_OPTS_INVALID')
    }
  }
})

test('handlerTimeout is exposed in fastify.initialConfig', t => {
  t.plan(3)

  t.assert.strictEqual(Fastify().initialConfig.handlerTimeout, 0)
  t.assert.strictEqual(Fastify({ handlerTimeout: 5000 }).initialConfig.handlerTimeout, 5000)
  // coerced like the other integer server options
  t.assert.strictEqual(Fastify({ handlerTimeout: '100' }).initialConfig.handlerTimeout, 100)
})

test('handlerTimeout route option must be an integer greater than 0', t => {
  t.plan(7)

  const fastify = Fastify()

  const invalidValues = [0, -1, 1.5, '100', NaN, null]
  for (const value of invalidValues) {
    try {
      fastify.get(`/${value}`, { handlerTimeout: value }, () => {})
      t.assert.fail(`handlerTimeout must be an integer > 0, got ${value}`)
    } catch (err) {
      t.assert.strictEqual(err.code, 'FST_ERR_ROUTE_HANDLER_TIMEOUT_OPTION_NOT_INT')
    }
  }

  try {
    fastify.get('/valid', { handlerTimeout: 100 }, () => {})
    t.assert.ok(true, 'a positive integer is accepted')
  } catch (err) {
    t.assert.fail(err)
  }
})

test('a route cannot disable a server level handlerTimeout', t => {
  t.plan(2)

  const fastify = Fastify({ handlerTimeout: 1000 })

  try {
    fastify.get('/disabled', { handlerTimeout: 0 }, () => {})
    t.assert.fail('handlerTimeout: 0 must be rejected')
  } catch (err) {
    t.assert.strictEqual(err.code, 'FST_ERR_ROUTE_HANDLER_TIMEOUT_OPTION_NOT_INT')
  }

  try {
    fastify.get('/overridden', { handlerTimeout: 2000 }, () => {})
    t.assert.ok(true, 'a route can replace the server value with another positive integer')
  } catch (err) {
    t.assert.fail(err)
  }
})

test('request.routeOptions.handlerTimeout is the route value when set', async t => {
  t.plan(3)

  const fastify = Fastify({ handlerTimeout: 1000 })
  t.after(() => fastify.close())

  fastify.get('/route-timeout', {
    handlerTimeout: 250,
    handler (request, reply) {
      t.assert.strictEqual(request.routeOptions.handlerTimeout, 250)
      reply.send({})
    }
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/route-timeout')
  t.assert.ok(result.ok)
  t.assert.strictEqual(result.status, 200)
})

test('request.routeOptions.handlerTimeout falls back to the server value', async t => {
  t.plan(3)

  const fastify = Fastify({ handlerTimeout: 1000 })
  t.after(() => fastify.close())

  fastify.get('/server-timeout', {
    handler (request, reply) {
      t.assert.strictEqual(request.routeOptions.handlerTimeout, 1000)
      reply.send({})
    }
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/server-timeout')
  t.assert.ok(result.ok)
  t.assert.strictEqual(result.status, 200)
})

test('request.routeOptions.handlerTimeout is 0 when not configured', async t => {
  t.plan(3)

  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/no-timeout', {
    handler (request, reply) {
      t.assert.strictEqual(request.routeOptions.handlerTimeout, 0)
      reply.send({})
    }
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/no-timeout')
  t.assert.ok(result.ok)
  t.assert.strictEqual(result.status, 200)
})

test('request exceeding the handlerTimeout receives a 503 FST_ERR_HANDLER_TIMEOUT', async t => {
  t.plan(5)

  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/slow', { handlerTimeout: 100 }, async (request, reply) => {
    await sleep(5000)
    return { hello: 'world' }
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/slow')
  const body = await result.json()

  t.assert.strictEqual(result.status, 503)
  t.assert.strictEqual(body.code, 'FST_ERR_HANDLER_TIMEOUT')
  t.assert.strictEqual(body.error, 'Service Unavailable')
  t.assert.ok(body.message.includes('100 ms'), 'message contains the timeout in milliseconds')
  t.assert.ok(body.message.includes('/slow'), 'message contains the route url')
})

test('handlerTimeout includes the time spent in lifecycle hooks', async t => {
  t.plan(2)

  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/slow-hook', {
    handlerTimeout: 100,
    onRequest: async () => {
      await sleep(5000)
    }
  }, async (request, reply) => {
    return { hello: 'world' }
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/slow-hook')
  const body = await result.json()

  t.assert.strictEqual(result.status, 503)
  t.assert.strictEqual(body.code, 'FST_ERR_HANDLER_TIMEOUT')
})

test('request completed within the handlerTimeout is not affected', async t => {
  t.plan(3)

  const fastify = Fastify({ handlerTimeout: 1000 })
  t.after(() => fastify.close())

  fastify.get('/fast', async (request, reply) => {
    await sleep(50)
    return { hello: 'world' }
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/fast')
  const body = await result.json()

  t.assert.strictEqual(result.status, 200)
  t.assert.deepStrictEqual(body, { hello: 'world' })

  // give the (cleared) timer a chance to fire if it was not cleared
  await sleep(1100)
  t.assert.ok(true, 'no timeout error was sent after the response')
})

test('route handlerTimeout overrides the server value', async t => {
  t.plan(2)

  const fastify = Fastify({ handlerTimeout: 100 })
  t.after(() => fastify.close())

  fastify.get('/override', { handlerTimeout: 1000 }, async (request, reply) => {
    await sleep(300)
    return { hello: 'world' }
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/override')

  t.assert.strictEqual(result.status, 200)
  t.assert.deepStrictEqual(await result.json(), { hello: 'world' })
})

test('routes without handlerTimeout use the server value', async t => {
  t.plan(2)

  const fastify = Fastify({ handlerTimeout: 100 })
  t.after(() => fastify.close())

  fastify.get('/inherits', async (request, reply) => {
    await sleep(5000)
    return { hello: 'world' }
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/inherits')
  const body = await result.json()

  t.assert.strictEqual(result.status, 503)
  t.assert.strictEqual(body.code, 'FST_ERR_HANDLER_TIMEOUT')
})

test('handlerTimeout error is handled by the encapsulation context error handler', async t => {
  t.plan(3)

  const fastify = Fastify({ handlerTimeout: 100 })
  t.after(() => fastify.close())

  fastify.register(async function (child) {
    child.setErrorHandler((error, request, reply) => {
      if (error.code === 'FST_ERR_HANDLER_TIMEOUT') {
        reply.code(504).send({ error: 'Gateway Timeout', custom: true })
        return
      }
      reply.send(error)
    })

    child.get('/slow', async (request, reply) => {
      await sleep(5000)
      return { hello: 'world' }
    })
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/slow')
  const body = await result.json()

  t.assert.strictEqual(result.status, 504)
  t.assert.deepStrictEqual(body, { error: 'Gateway Timeout', custom: true })
  t.assert.ok(true)
})

test('handlerTimeout error is handled by the route errorHandler option', async t => {
  t.plan(2)

  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/slow', {
    handlerTimeout: 100,
    errorHandler: (error, request, reply) => {
      if (error.code === 'FST_ERR_HANDLER_TIMEOUT') {
        reply.code(504).send({ error: 'Gateway Timeout' })
        return
      }
      reply.send(error)
    }
  }, async (request, reply) => {
    await sleep(5000)
    return { hello: 'world' }
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/slow')

  t.assert.strictEqual(result.status, 504)
  t.assert.deepStrictEqual(await result.json(), { error: 'Gateway Timeout' })
})

test('request.signal is aborted with the FST_ERR_HANDLER_TIMEOUT error on timeout', async t => {
  t.plan(6)

  const fastify = Fastify()
  t.after(() => fastify.close())

  let signalChecked = false
  fastify.get('/slow', { handlerTimeout: 100 }, async (request, reply) => {
    t.assert.strictEqual(request.signal.aborted, false)
    request.signal.addEventListener('abort', () => {
      signalChecked = true
      t.assert.strictEqual(request.signal.aborted, true)
      t.assert.strictEqual(request.signal.reason.code, 'FST_ERR_HANDLER_TIMEOUT')
      t.assert.strictEqual(request.signal.reason.statusCode, 503)
    })
    await sleep(5000)
    return { hello: 'world' }
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/slow')

  // the abort event is dispatched synchronously before the 503 is sent
  t.assert.strictEqual(result.status, 503)
  t.assert.ok(signalChecked, 'signal was aborted before the response was received')
})

test('request.signal is aborted with an AbortError when the client disconnects', async t => {
  t.plan(4)

  const fastify = Fastify()
  t.after(() => fastify.close())

  let resolveAborted
  const aborted = new Promise(resolve => { resolveAborted = resolve })

  fastify.get('/slow', async (request, reply) => {
    t.assert.strictEqual(request.signal.aborted, false)
    request.signal.addEventListener('abort', () => {
      t.assert.strictEqual(request.signal.aborted, true)
      t.assert.strictEqual(request.signal.reason.name, 'AbortError')
      t.assert.notStrictEqual(request.signal.reason.code, 'FST_ERR_HANDLER_TIMEOUT')
      resolveAborted()
    })
    await sleep(5000)
    return { hello: 'world' }
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const socket = connect(new URL(fastifyServer).port)
  socket.write('GET /slow HTTP/1.1\r\nHost: example.com\r\n\r\n')
  await sleep(200)
  socket.destroy()
  await aborted
})

test('request.signal is not aborted when the request completes normally', async t => {
  t.plan(3)

  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/fast', async (request, reply) => {
    t.assert.strictEqual(request.signal.aborted, false)
    t.assert.ok(request.signal instanceof AbortSignal)
    return { hello: 'world' }
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/fast')

  t.assert.strictEqual(result.status, 200)
})

test('the timeout is cooperative and does not interrupt the handler', async t => {
  t.plan(4)

  const fastify = Fastify()
  t.after(() => fastify.close())

  let resolveLate
  const late = new Promise(resolve => { resolveLate = resolve })

  fastify.get('/slow', { handlerTimeout: 100 }, async (request, reply) => {
    await sleep(300)
    // the handler is still running after the 503 has been sent
    t.assert.strictEqual(request.signal.aborted, true)
    t.assert.strictEqual(request.signal.reason.code, 'FST_ERR_HANDLER_TIMEOUT')
    // a late reply.send() must not break the framework
    reply.send({ hello: 'world' })
    resolveLate()
    return { hello: 'world' }
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/slow')

  t.assert.strictEqual(result.status, 503)
  t.assert.strictEqual((await result.json()).code, 'FST_ERR_HANDLER_TIMEOUT')

  await late
})

test('a timed out request does not break the keep-alive connection', async t => {
  t.plan(4)

  const fastify = Fastify({ handlerTimeout: 100 })
  t.after(() => fastify.close())

  fastify.get('/slow', async (request, reply) => {
    await sleep(5000)
    return { hello: 'world' }
  })
  fastify.get('/fast', async (request, reply) => {
    return { hello: 'world' }
  })

  const fastifyServer = await fastify.listen({ port: 0 })

  // undici reuses the same keep-alive connection for both requests
  const slowResult = await fetch(fastifyServer + '/slow')
  t.assert.strictEqual(slowResult.status, 503)
  t.assert.strictEqual((await slowResult.json()).code, 'FST_ERR_HANDLER_TIMEOUT')

  const fastResult = await fetch(fastifyServer + '/fast')
  t.assert.strictEqual(fastResult.status, 200)
  t.assert.deepStrictEqual(await fastResult.json(), { hello: 'world' })
})

test('request.signal is undefined-safe when neither timeout nor listener is used', async t => {
  t.plan(2)

  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/plain', (request, reply) => {
    reply.send({ hello: 'world' })
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/plain')

  t.assert.strictEqual(result.status, 200)
  t.assert.deepStrictEqual(await result.json(), { hello: 'world' })
})

test('server handlerTimeout applies to the not found handler', async t => {
  t.plan(3)

  const fastify = Fastify({ handlerTimeout: 100 })
  t.after(() => fastify.close())

  fastify.setNotFoundHandler(async (request, reply) => {
    await sleep(5000)
    reply.code(404).send({ not: 'found' })
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/does-not-exist')
  const body = await result.json()

  t.assert.strictEqual(result.status, 503)
  t.assert.strictEqual(body.code, 'FST_ERR_HANDLER_TIMEOUT')
  t.assert.ok(body.message.includes('/does-not-exist'), 'message contains the request url')
})

test('handlerTimeout does not send an error when the reply was hijacked', async t => {
  t.plan(3)

  const fastify = Fastify()
  t.after(() => fastify.close())

  let resolveAborted
  const aborted = new Promise(resolve => { resolveAborted = resolve })

  fastify.get('/hijacked', { handlerTimeout: 100 }, (request, reply) => {
    reply.hijack()
    request.signal.addEventListener('abort', () => {
      t.assert.strictEqual(request.signal.aborted, true)
      t.assert.strictEqual(request.signal.reason.code, 'FST_ERR_HANDLER_TIMEOUT')
      resolveAborted()
    })
    // the response is never sent
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const socket = connect(new URL(fastifyServer).port)
  t.after(() => socket.destroy())

  socket.write('GET /hijacked HTTP/1.1\r\nHost: example.com\r\n\r\n')
  await aborted
  t.assert.ok(true, 'no error response was sent for the hijacked reply')
})

test('handlerTimeout expiring during an onError hook does not break the error handling', async t => {
  t.plan(3)

  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.addHook('onError', async (request, reply, error) => {
    await sleep(500)
  })

  fastify.get('/boom', { handlerTimeout: 100 }, async (request, reply) => {
    throw new Error('boom')
  })

  const fastifyServer = await fastify.listen({ port: 0 })
  const result = await fetch(fastifyServer + '/boom')
  const body = await result.json()

  // the original error response is sent once the onError hook completes
  t.assert.strictEqual(result.status, 500)
  t.assert.strictEqual(body.message, 'boom')
  t.assert.ok(true, 'the timeout error did not interrupt the error handling')
})
