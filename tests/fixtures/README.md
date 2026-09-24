# Test fixtures

`test-cert.pem` / `test-key.pem` — a throwaway self-signed certificate used
only by `tests/server.test.ts` to verify that `createServer()` builds an
HTTPS server when TLS is configured. It has no relation to any real
deployment and is safe to commit. Regenerate with:

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout test-key.pem -out test-cert.pem \
  -days 3650 -subj "/CN=test.local"
```
