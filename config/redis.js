const Redis = require('ioredis');

let client = null;

function getRedis() {
  if (client) return client;
  client = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: false,
    maxRetriesPerRequest: 2
  });
  client.on('error', (err) => console.error('[Redis]', err.message));
  return client;
}

module.exports = { getRedis };
