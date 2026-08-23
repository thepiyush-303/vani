#!/bin/bash
# run-smoke.sh — Start server, run smoke client, then kill server
set -e

cd "$(dirname "$0")"

npx ts-node src/server.ts &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null; exit" EXIT INT TERM

sleep 2
npx ts-node smoke-client.ts
