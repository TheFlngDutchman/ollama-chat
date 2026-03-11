#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -d "node_modules" ]; then
  echo "▓ Installing dependencies..."
  npm install
fi
echo "▓ Starting OLLAMA TUI at http://localhost:3131"
node server.js
