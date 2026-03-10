#!/usr/bin/env bash
set -o errexit

echo "📦 Installing dependencies..."
npm install

# Puppeteer cache management
PUPPETEER_CACHE_DIR=".cache/puppeteer"
BUILD_CACHE_DIR="$XDG_CACHE_HOME/puppeteer"

if [[ -d "$BUILD_CACHE_DIR" ]]; then
  echo "📂 Using cached Puppeteer Chromium from previous build..."
  mkdir -p "$(dirname $PUPPETEER_CACHE_DIR)"
  cp -R "$BUILD_CACHE_DIR" "$PUPPETEER_CACHE_DIR"
else
  echo "🧩 Downloading fresh Puppeteer Chromium..."
  npm rebuild puppeteer
  echo "💾 Saving Puppeteer cache for next build..."
  mkdir -p "$(dirname $BUILD_CACHE_DIR)"
  cp -R "$PUPPETEER_CACHE_DIR" "$BUILD_CACHE_DIR"
fi

echo "📍 List of installed dependencies:"
npm ls

echo "📍 Finding vulnerabilities:"
npm audit --audit-level=moderate
npm audit fix

echo "✅️ Dependencies installed, ready to start!"