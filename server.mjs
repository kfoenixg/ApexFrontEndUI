// server.mjs
import { createServer } from 'node:http';

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // important for Codespaces

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello World\n');
});

server.listen(PORT, HOST, () => {
  console.log(`Listening on ${HOST}:${PORT}`);
});
