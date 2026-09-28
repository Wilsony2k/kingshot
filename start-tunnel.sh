#!/bin/bash
echo "🚀 Kingshot DB - Cloudflare Tunnel Quick Start"
echo ""

if ! command -v cloudflared &> /dev/null; then
    echo "❌ cloudflared not found. Please install it first."
    exit 1
fi

echo "🔍 Checking local server on port 8080..."
if ! curl -s http://localhost:8080 > /dev/null 2>&1; then
    echo "⚠️  Local server not running. Please check Nginx."
    exit 1
fi
echo "✅ Local server is running on port 8080"

echo ""
echo "🔍 Checking Cloudflare tunnel..."
if cloudflared tunnel list 2>/dev/null | grep -q "kingshot-tunnel"; then
    echo "✅ Tunnel 'kingshot-tunnel' exists"
else
    echo "⚠️  Tunnel 'kingshot-tunnel' not found"
    echo ""
    echo "📋 Please create a tunnel first:"
    echo "   1. Run: cloudflared tunnel login"
    echo "   2. Run: cloudflared tunnel create kingshot-tunnel"
    echo "   3. Run: cloudflared tunnel route dns kingshot-tunnel kingshot.85200852.xyz"
    echo "   4. Then run this script again"
    exit 1
fi

echo ""
echo "🚀 Starting Cloudflare Tunnel..."
echo "   Mapping: https://kingshot.85200852.xyz → http://localhost:8080"
echo ""
echo "   Press Ctrl+C to stop the tunnel"
echo ""

cp /home/wilsonc/DSH/Kingshot/cloudflared-config.yml ~/.cloudflared/config.yml
cloudflared tunnel run kingshot-tunnel
