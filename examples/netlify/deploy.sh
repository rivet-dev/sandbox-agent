#!/bin/bash

# Netlify Sandbox Agent Deployment Script
# This script automates the deployment of sandbox-agent to Netlify

set -e

echo "🚀 Netlify Sandbox Agent Deployment Script"
echo "=========================================="
echo

# Check if we're in the right directory
if [ ! -f "netlify.toml" ]; then
    echo "❌ Error: netlify.toml not found. Please run this script from the netlify example directory."
    exit 1
fi

# Check if Netlify CLI is installed
if ! command -v netlify &> /dev/null; then
    echo "❌ Error: Netlify CLI not found."
    echo "Please install it with: npm install -g netlify-cli"
    exit 1
fi

echo "✅ Netlify CLI found"

# Check if logged in to Netlify
if ! netlify status &> /dev/null; then
    echo "🔐 You need to login to Netlify first:"
    netlify login
fi

echo "✅ Logged in to Netlify"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

echo "✅ Dependencies installed"

# Check for environment variables
if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$OPENAI_API_KEY" ]; then
    echo "⚠️ API keys not found in environment variables."
    echo "You need to set either ANTHROPIC_API_KEY or OPENAI_API_KEY"
    echo
    echo "Options:"
    echo "1. Set environment variables locally"
    echo "2. Set them in Netlify after deployment"
    echo "3. Set them now via Netlify CLI"
    echo
    read -p "Do you want to set API keys via Netlify CLI now? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Setting API keys via Netlify CLI..."
        echo "Choose which API key to set:"
        echo "1. Anthropic API Key (recommended)"
        echo "2. OpenAI API Key"
        read -p "Enter your choice (1 or 2): " -n 1 -r
        echo
        
        if [[ $REPLY == "1" ]]; then
            read -p "Enter your Anthropic API Key: " -s anthropic_key
            echo
            netlify env:set ANTHROPIC_API_KEY "$anthropic_key"
            echo "✅ Anthropic API key set"
        elif [[ $REPLY == "2" ]]; then
            read -p "Enter your OpenAI API Key: " -s openai_key
            echo
            netlify env:set OPENAI_API_KEY "$openai_key"
            echo "✅ OpenAI API key set"
        else
            echo "Invalid choice. You can set API keys later in the Netlify dashboard."
        fi
    fi
fi

echo
echo "🚀 Deploying to Netlify..."

# Deploy to production
netlify deploy --prod

echo
echo "🎉 Deployment completed!"
echo

# Get the site URL
SITE_URL=$(netlify status --json | grep -o '"url":"[^"]*"' | cut -d'"' -f4)

if [ -n "$SITE_URL" ]; then
    echo "📍 Your sandbox-agent is deployed at: $SITE_URL"
    echo
    echo "🧪 Test your deployment:"
    echo "npm run test:integration $SITE_URL"
    echo
    echo "📚 View function logs:"
    echo "netlify functions:list"
    echo "netlify logs"
    echo
    echo "🔧 Manage environment variables:"
    echo "netlify env:list"
    echo "netlify env:set KEY value"
else
    echo "⚠️ Could not detect site URL. Check 'netlify status' manually."
fi

echo
echo "✨ Next steps:"
echo "1. Test your deployment with the integration test"
echo "2. Set up any missing environment variables"
echo "3. Check the function logs if you encounter issues"
echo "4. Use the deployment URL in your applications"
echo