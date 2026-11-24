const http = require('node:http');

const version = process.env.APP_VERSION || 'v1';
const mode = process.env.FIXTURE_MODE || 'healthy';

console.log(`runtime API_SECRET_KEY=${process.env.API_SECRET_KEY || ''}`);
console.error(`runtime DB_TOKEN=${process.env.DB_TOKEN || ''}`);

if (mode === 'exit') {
  process.exit(42);
} else if (mode === 'no-listen') {
  setInterval(() => {}, 1000);
} else {
  const server = http.createServer((request, response) => {
    if (request.url === '/health' && mode === 'timeout') return;
    const unhealthy = request.url === '/health' && mode === 'unhealthy';
    response.writeHead(unhealthy ? 503 : 200, { 'Content-Type': 'text/plain' });
    response.end(unhealthy ? 'unavailable' : version);
  });
  server.listen(3000, '0.0.0.0', () => console.log(`listening ${version}`));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}