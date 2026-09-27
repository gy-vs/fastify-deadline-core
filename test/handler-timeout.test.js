'use strict'

const { test } = require('node:test')
const http = require('node:http')
const { connect } = require('node:net')
const Fastify = require('..')
const { kRequestAbortController } = require('../lib/symbols.js')
const { sleep } = require('./helper')

test('handlerTimeout server option is validated at instantiation', t => {
  t.plan(7)

  try {
    Fastify({ handlerTimeout: 1.5 })
    t.assert.fail('option must be an integer')
  } catch (err) {
    t.assert.strictEqual(err.code, 'FST_ERR_INIT_OPTS_INVALID')
  }

  try {
    Fastify({ handlerTimeout: [] })
    t.assert.fail('option must be an integer')
  } catch (err) {
    t.assert.strictEqual(err.code, 'FST_ERR_INIT_OPTS_INVALID')
  }

  try {
    Fastify({ handlerTimeout: 'not-a-number' })
    t.assert.fail('option must be an integer')
  } catch (err) {
    t.assert.strictEqual(err.code, 'FST_ERR_INIT_OPTS_INVALID')
  }

  t.assert.strictEqual(Fastify().initialConfig.handlerTimeout, 0)
  t.assert.strictEqual(Fastify({ handlerTimeout: 1000 }).initialConfig.handlerTimeout, 1000)
  t.assert.strictEqual(Fastify({ handlerTimeout: 0 }).initialConfig.handlerTimeout, 0)
  t.assert.ok(Object.isFrozen(Fastify({ handlerTimeout: 1000 }).initialConfig))
})

test('handlerTimeout route option is validated at registration', t => {
  t.plan(6)

  const fastify = Fastify()
  const handler = (req, reply) => reply.send({})

  for (const handlerTimeout of [0, -1, 1.5, '100', NaN]) {
    try {
      fastify.get(`/invalid-${handlerTimeout}`, { handlerTimeout }, handler)
      t.assert.fail(`handlerTimeout ${handlerTimeout} must throw`)
    } catch (err) {
      t.assert.strictEqual(err.code, 'FST_ERR_ROUTE_HANDLER_TIMEOUT_OPTION_NOT_INT')
    }
  }

  fastify.get('/valid', { handlerTimeout: 1000 }, handler)
  t.assert.ok(fastify.hasRoute({ method: 'GET', url: '/valid' }))
})

test('a route cannot disable a server-wide handlerTimeout', t => {
  t.plan(2)

  const fastify = Fastify({ handlerTimeout: 1000 })

  try {
    fastify.get('/disabled', { handlerTimeout: 0 }, (req, reply) => reply.send({}))
    t.assert.fail('handlerTimeout 0 must throw')
  } catch (err) {
    t.assert.strictEqual(err.code, 'FST_ERR_ROUTE_HANDLER_TIMEOUT_OPTION_NOT_INT')
  }

  fastify.get('/narrowed', { handlerTimeout: 100 }, (req, reply) => {
    reply.send({ handlerTimeout: req.routeOptions.handlerTimeout })
  })

  return fastify.inject('/narrowed').then((res) => {
    t.assert.strictEqual(res.json().handlerTimeout, 100)
  })
})

test('request.routeOptions exposes the effective handlerTimeout', async t => {
  t.plan(4)
  const fastify = Fastify({ handlerTimeout: 1000 })
  t.after(() => fastify.close())

  fastify.get('/inherit', (req, reply) => {
    t.assert.strictEqual(req.routeOptions.handlerTimeout, 1000)
    reply.send({})
  })
  fastify.get('/override', { handlerTimeout: 2000 }, (req, reply) => {
    t.assert.strictEqual(req.routeOptions.handlerTimeout, 2000)
    reply.send({})
  })

  const noTimeout = Fastify()
  t.after(() => noTimeout.close())
  noTimeout.get('/', (req, reply) => {
    t.assert.strictEqual(req.routeOptions.handlerTimeout, 0)
    reply.send({})
  })

  await fastify.inject('/inherit')
  await fastify.inject('/override')
  await noTimeout.inject('/')
  t.assert.ok(true)
})

test('handlerTimeout replies 503 with FST_ERR_HANDLER_TIMEOUT', async t => {
  t.plan(6)
  const fastify = Fastify({ handlerTimeout: 100 })
  t.after(() => fastify.close())

  fastify.get('/slow', async (req, reply) => {
    await sleep(1000)
    return { hello: 'world' }
  })

  const res = await fastify.inject('/slow')
  t.assert.strictEqual(res.statusCode, 503)
  const body = res.json()
  t.assert.strictEqual(body.code, 'FST_ERR_HANDLER_TIMEOUT')
  t.assert.strictEqual(body.error, 'Service Unavailable')
  t.assert.strictEqual(body.statusCode, 503)
  t.assert.ok(body.message.includes('100'), 'message contains the timeout in ms')
  t.assert.ok(body.message.includes('/slow'), 'message contains the route url')
})

test('handlerTimeout covers the whole lifecycle, hooks included', async t => {
  t.plan(2)
  const fastify = Fastify({ handlerTimeout: 100 })
  t.after(() => fastify.close())

  fastify.get('/slow-hook', {
    onRequest: () => new Promise(() => { })
  }, async () => {
    t.assert.fail('handler must not run')
  })

  fastify.post('/slow-body', {
    preParsing: () => new Promise(() => { })
  }, async () => {
    t.assert.fail('handler must not run')
  })

  const hookRes = await fastify.inject('/slow-hook')
  t.assert.strictEqual(hookRes.statusCode, 503)

  // body parsing is still in progress when the timeout elapses
  const bodyRes = await fastify.inject({
    method: 'POST',
    url: '/slow-body',
    body: { hello: 'world' }
  })
  t.assert.strictEqual(bodyRes.statusCode, 503)
})

test('handlerTimeout does not fire when the response is sent in time', async t => {
  t.plan(3)
  const fastify = Fastify({ handlerTimeout: 200 })
  t.after(() => fastify.close())

  fastify.get('/fast', async () => {
    await sleep(50)
    return { hello: 'world' }
  })

  const res = await fastify.inject('/fast')
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.deepStrictEqual(res.json(), { hello: 'world' })

  // give the timer a chance to fire if it was not cleared
  await sleep(300)
  t.assert.ok(true, 'no late timeout fired')
})

test('handlerTimeout is cooperative, a late handler completion does not break the server', async t => {
  t.plan(4)
  const fastify = Fastify({ handlerTimeout: 100 })
  t.after(() => fastify.close())

  let handlerFinished = false
  fastify.get('/slow', async () => {
    await sleep(300)
    handlerFinished = true
    return { hello: 'world' }
  })
  fastify.get('/fast', () => ({ hello: 'fast' }))

  const slowRes = await fastify.inject('/slow')
  t.assert.strictEqual(slowRes.statusCode, 503)
  t.assert.strictEqual(handlerFinished, false)

  await sleep(400)
  t.assert.strictEqual(handlerFinished, true, 'handler was not interrupted')

  const fastRes = await fastify.inject('/fast')
  t.assert.strictEqual(fastRes.statusCode, 200)
})

test('handlerTimeout error is routed to the encapsulation context error handler', async t => {
  t.plan(3)
  const fastify = Fastify({ handlerTimeout: 100 })
  t.after(() => fastify.close())

  fastify.register(async (instance) => {
    instance.setErrorHandler((error, request, reply) => {
      if (error.code === 'FST_ERR_HANDLER_TIMEOUT') {
        reply.code(504).send({ error: 'Gateway Timeout', code: error.code })
        return
      }
      reply.send(error)
    })
    instance.get('/plugin-slow', async () => {
      await sleep(1000)
      return {}
    })
  })

  const res = await fastify.inject('/plugin-slow')
  t.assert.strictEqual(res.statusCode, 504)
  t.assert.strictEqual(res.json().code, 'FST_ERR_HANDLER_TIMEOUT')
  t.assert.strictEqual(res.json().error, 'Gateway Timeout')
})

test('handlerTimeout error is routed to the route errorHandler option', async t => {
  t.plan(2)
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/slow', {
    handlerTimeout: 100,
    errorHandler: (error, request, reply) => {
      reply.code(504).send({ error: 'Gateway Timeout', code: error.code })
    }
  }, async () => {
    await sleep(1000)
    return {}
  })

  const res = await fastify.inject('/slow')
  t.assert.strictEqual(res.statusCode, 504)
  t.assert.strictEqual(res.json().code, 'FST_ERR_HANDLER_TIMEOUT')
})

test('request.signal is aborted with FST_ERR_HANDLER_TIMEOUT on timeout', async t => {
  t.plan(4)
  const fastify = Fastify({ handlerTimeout: 100 })
  t.after(() => fastify.close())

  fastify.get('/slow', async (req) => {
    t.assert.ok(req.signal instanceof AbortSignal)
    t.assert.strictEqual(req.signal, req.signal, 'signal getter is stable')
    const aborted = new Promise((resolve) => {
      req.signal.addEventListener('abort', () => resolve(req.signal.reason))
    })
    const reason = await aborted
    t.assert.strictEqual(reason.code, 'FST_ERR_HANDLER_TIMEOUT')
    await sleep(500)
    return {}
  })

  const res = await fastify.inject('/slow')
  t.assert.strictEqual(res.statusCode, 503)
})

test('request.signal is aborted with AbortError when the client disconnects', (t, testDone) => {
  t.plan(5)
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', async (req) => {
    t.assert.ok(req.signal instanceof AbortSignal)
    t.assert.strictEqual(req.signal.aborted, false)
    const aborted = new Promise((resolve) => {
      req.signal.addEventListener('abort', () => resolve(req.signal.reason))
    })
    const reason = await aborted
    t.assert.strictEqual(reason.name, 'AbortError')
    t.assert.notStrictEqual(reason.code, 'FST_ERR_HANDLER_TIMEOUT')
    testDone()
    // wait so the response is not sent before the test finishes
    await sleep(500)
    return {}
  })

  fastify.listen({ port: 0 }, err => {
    t.assert.ifError(err)

    const socket = connect(fastify.server.address().port)
    socket.write('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n')
    sleep(200).then(() => socket.destroy())
  })
})

test('request.signal is aborted with AbortError on disconnect also when handlerTimeout is set', (t, testDone) => {
  t.plan(2)
  const fastify = Fastify({ handlerTimeout: 10000 })
  t.after(() => fastify.close())

  fastify.get('/', async (req) => {
    const aborted = new Promise((resolve) => {
      req.signal.addEventListener('abort', () => resolve(req.signal.reason))
    })
    const reason = await aborted
    t.assert.strictEqual(reason.name, 'AbortError')
    testDone()
    await sleep(500)
    return {}
  })

  fastify.listen({ port: 0 }, err => {
    t.assert.ifError(err)

    const socket = connect(fastify.server.address().port)
    socket.write('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n')
    sleep(200).then(() => socket.destroy())
  })
})

test('no abort controller is created when the request does not use the feature', async t => {
  t.plan(3)
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/', (req, reply) => {
    t.assert.strictEqual(req[kRequestAbortController], undefined)
    reply.send({ hello: 'world' })
  })

  const res = await fastify.inject('/')
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.deepStrictEqual(res.json(), { hello: 'world' })
})

test('handlerTimeout works on keep-alive connections reused by a gateway', async t => {
  t.plan(4)
  const fastify = Fastify({ handlerTimeout: 150 })
  t.after(() => fastify.close())

  fastify.get('/hang', () => new Promise(() => { }))
  fastify.get('/ok', () => ({ hello: 'world' }))

  await fastify.listen({ port: 0 })
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  t.after(() => agent.destroy())

  const port = fastify.server.address().port
  const first = await new Promise((resolve, reject) => {
    http.get({ port, path: '/hang', agent }, resolve).on('error', reject)
  })
  t.assert.strictEqual(first.statusCode, 503)
  let body = ''
  for await (const chunk of first) body += chunk
  t.assert.strictEqual(JSON.parse(body).code, 'FST_ERR_HANDLER_TIMEOUT')

  // the connection pool is freed: the next request on the same socket is served
  const second = await new Promise((resolve, reject) => {
    http.get({ port, path: '/ok', agent }, resolve).on('error', reject)
  })
  t.assert.strictEqual(second.statusCode, 200)
  let secondBody = ''
  for await (const chunk of second) secondBody += chunk
  t.assert.deepStrictEqual(JSON.parse(secondBody), { hello: 'world' })
})

test('404 handler is covered by the server-wide handlerTimeout', async t => {
  t.plan(2)
  const fastify = Fastify({ handlerTimeout: 100 })
  t.after(() => fastify.close())

  fastify.setNotFoundHandler(async () => {
    await sleep(1000)
    return {}
  })

  const res = await fastify.inject('/not-found')
  t.assert.strictEqual(res.statusCode, 503)
  t.assert.strictEqual(res.json().code, 'FST_ERR_HANDLER_TIMEOUT')
})

test('404 responses are not affected when fast', async t => {
  t.plan(2)
  const fastify = Fastify({ handlerTimeout: 100 })
  t.after(() => fastify.close())

  const res = await fastify.inject('/not-found')
  t.assert.strictEqual(res.statusCode, 404)
  t.assert.strictEqual(res.json().message, 'Route GET:/not-found not found')
})

test('handlerTimeout aborts the signal of a hijacked reply without sending', async t => {
  t.plan(3)
  const fastify = Fastify({ handlerTimeout: 100 })
  t.after(() => fastify.close())

  fastify.get('/hijacked', (req, reply) => {
    reply.hijack()
    req.signal.addEventListener('abort', () => {
      t.assert.strictEqual(req.signal.reason.code, 'FST_ERR_HANDLER_TIMEOUT')
      reply.raw.end('stopped by signal')
    })
  })

  const res = await fastify.inject('/hijacked')
  // the framework did not send its own 503, the handler answered on abort
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.body, 'stopped by signal')
})

test('request.signal is not aborted when the response completes normally', async t => {
  t.plan(3)
  const fastify = Fastify()
  t.after(() => fastify.close())

  let signalAfterResponse
  fastify.get('/', (req, reply) => {
    req.signal.addEventListener('abort', () => {
      t.assert.fail('signal must not be aborted')
    })
    signalAfterResponse = req.signal
    reply.send({ hello: 'world' })
  })

  await fastify.listen({ port: 0 })
  const res = await new Promise((resolve, reject) => {
    http.get({ port: fastify.server.address().port }, resolve).on('error', reject)
  })
  t.assert.strictEqual(res.statusCode, 200)
  res.resume()
  await new Promise(resolve => res.on('end', resolve))
  await sleep(100)
  t.assert.strictEqual(signalAfterResponse.aborted, false)
  t.assert.ok(signalAfterResponse instanceof AbortSignal)
})
